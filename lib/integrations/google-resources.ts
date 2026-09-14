/**
 * The second step of a Google connection: which property / account / location
 * the agents should use. A grant covers everything the Google account can see;
 * the handlers need exactly one.
 *
 * One entry per Google provider. The connect page and
 * /api/integrations/google/resource are generic over this table — adding a
 * Google provider means adding an entry here, not a new route or picker.
 */
import type { GoogleCredentials } from "./google";
import { GOOGLE_ADS_API_VERSION, googleAdsHeaders, listGscSites } from "./google";
import { AgentInputError } from "@/lib/ai/errors";

export type ResourceOption = { value: string; label: string; detail?: string };

export type GoogleResource = {
  /** Shown above the picker: "Property", "Location"… */
  noun: string;
  list(accessToken: string): Promise<ResourceOption[]>;
  /** The value currently chosen, read back out of stored credentials. */
  selected(creds: GoogleCredentials & Record<string, unknown>): string | null;
  /** Write the choice into the credential shape the handlers decrypt. */
  apply(creds: GoogleCredentials & Record<string, unknown>, value: string): Record<string, unknown>;
};

export const GOOGLE_RESOURCES: Partial<Record<string, GoogleResource>> = {
  GOOGLE_SEARCH_CONSOLE: {
    noun: "Search Console property",
    async list(accessToken) {
      const sites = await listGscSites(accessToken);
      return sites.map((s) => ({
        value: s.siteUrl,
        label: s.siteUrl.startsWith("sc-domain:") ? `${s.siteUrl.slice(10)} (domain)` : s.siteUrl,
        detail: s.permissionLevel.replace(/^site/, ""),
      }));
    },
    selected: (creds) => creds.property_url || null,
    apply: (creds, value) => ({ ...creds, property_url: value }),
  },

  GOOGLE_ANALYTICS_4: {
    noun: "GA4 property",
    async list(accessToken) {
      // accountSummaries is the one Admin API call that returns every property
      // the grant can read in one shot — the alternative is listing accounts,
      // then listing properties per account, N+1 calls for the same data.
      const res = await fetch("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Google Analytics Admin API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as {
        accountSummaries?: Array<{
          displayName?: string;
          propertySummaries?: Array<{ property: string; displayName?: string }>;
        }>;
      };
      const options: ResourceOption[] = [];
      for (const account of data.accountSummaries ?? []) {
        for (const prop of account.propertySummaries ?? []) {
          // Handlers build `properties/${property_id}:runReport` themselves —
          // store the bare id, not the `properties/123` resource name.
          options.push({
            value: prop.property.replace(/^properties\//, ""),
            label: prop.displayName || prop.property,
            detail: account.displayName,
          });
        }
      }
      return options.sort((a, b) => a.label.localeCompare(b.label));
    },
    selected: (creds) => (typeof creds.property_id === "string" ? creds.property_id : null),
    apply: (creds, value) => ({ ...creds, property_id: value }),
  },

  GOOGLE_BUSINESS_PROFILE: {
    noun: "Business location",
    async list(accessToken) {
      const headers = { Authorization: `Bearer ${accessToken}` };
      const acctRes = await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", { headers });
      if (!acctRes.ok) {
        throw new Error(`Google Business Profile Account Management API ${acctRes.status}: ${(await acctRes.text()).slice(0, 300)}`);
      }
      const acctData = (await acctRes.json()) as { accounts?: Array<{ name: string; accountName?: string }> };
      const accounts = acctData.accounts ?? [];
      if (accounts.length === 0) return [];

      const options: ResourceOption[] = [];
      for (const account of accounts) {
        const accountId = account.name.replace(/^accounts\//, "");
        // A personal Google account with no Business Profile locations 403s
        // here — that is a real "nothing to show for this account", not a
        // reason to fail the whole picker when other accounts do have locations.
        const locRes = await fetch(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=title,storefrontAddress&pageSize=100`,
          { headers },
        );
        if (!locRes.ok) continue;
        const locData = (await locRes.json()) as {
          locations?: Array<{ name: string; title?: string; storefrontAddress?: { locality?: string } }>;
        };
        for (const loc of locData.locations ?? []) {
          const locationId = loc.name.replace(/^locations\//, "");
          options.push({
            // Composite value: the reviews/localPosts endpoints (still on the
            // legacy mybusiness.googleapis.com/v4 host) need both ids in the
            // URL, and this picker only carries one string per choice.
            value: `${accountId}/${locationId}`,
            label: loc.title || locationId,
            detail: [account.accountName, loc.storefrontAddress?.locality].filter(Boolean).join(" · "),
          });
        }
      }
      return options;
    },
    selected: (creds) =>
      typeof creds.account_id === "string" && typeof creds.location_id === "string"
        ? `${creds.account_id}/${creds.location_id}`
        : null,
    apply: (creds, value) => {
      const [account_id, location_id] = value.split("/");
      return { ...creds, account_id, location_id };
    },
  },

  GOOGLE_ADS: {
    noun: "Ads account",
    async list(accessToken) {
      // listAccessibleCustomers only returns resource names — no descriptive
      // name, currency, or status. A per-customer GAQL lookup for
      // customer.descriptive_name would turn this into N extra calls; the
      // picker falls back to the formatted customer id as the label instead.
      const res = await fetch(
        `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`,
        { headers: googleAdsHeaders(accessToken) },
      );
      if (!res.ok) throw new Error(`Google Ads API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { resourceNames?: string[] };
      return (data.resourceNames ?? []).map((rn) => {
        const id = rn.replace(/^customers\//, "");
        const formatted = id.length === 10 ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id;
        return { value: id, label: formatted };
      });
    },
    selected: (creds) => (typeof creds.customer_id === "string" ? creds.customer_id : null),
    apply: (creds, value) => ({ ...creds, customer_id: value }),
  },
};

/**
 * Resolve a per-run "integration_resource" field: a value submitted with the
 * run (from the dropdown this table backs — see components/ui/ResourceSelect)
 * takes priority over the integration's saved default, but it is still just a
 * string a client sent, so it's checked against what the grant can actually
 * reach before anything trusts it. An override equal to the saved default (the
 * common case — the dropdown preselects it) skips that check for free.
 *
 * Returns the resolved value ("" if nothing is chosen and nothing is saved —
 * callers already handle that the same way they handled a bare property_url
 * lookup before this existed). Throws AgentInputError if a *different* value
 * was submitted and the grant can't reach it.
 */
export async function resolvePropertyOverride(
  provider: string,
  creds: GoogleCredentials & Record<string, unknown>,
  override: string,
): Promise<string> {
  const resource = GOOGLE_RESOURCES[provider];
  const saved = resource ? resource.selected(creds) ?? "" : "";
  if (!override || override === saved) return saved || override;
  if (!resource) return override; // no picker defined for this provider — nothing to verify against

  const options = await resource.list(creds.access_token);
  if (!options.some((o) => o.value === override)) {
    throw new AgentInputError(
      `"${override}" isn't one of the ${resource.noun} values the connected Google account can reach.`,
      "Pick a value from the dropdown, or reconnect the integration if it should be listed there.",
      "integration_resource_unreachable",
    );
  }
  return override;
}
