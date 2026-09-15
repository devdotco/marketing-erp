/**
 * Google Ads API plumbing with no database and no `next/*` imports: headers,
 * the account picker's listing across manager (MCC) accounts, the stored
 * account value, and plain-English error mapping. Pure over an injectable
 * `fetch`, so test/content.test.ts can drive it without a network.
 *
 * Why this exists: `customers:listAccessibleCustomers` only returns accounts
 * the signed-in Google login is DIRECTLY a user on. An agency login usually
 * has direct access to its manager account only, and every client account
 * under it has to be (a) discovered through the manager's `customer_client`
 * rows and (b) queried with `login-customer-id` set to that manager — without
 * it Google answers USER_PERMISSION_DENIED. Each workspace's manager is
 * different, so the manager travels with the chosen account instead of living
 * in one server-wide env var.
 */
import { AgentInputError } from "@/lib/ai/errors";

/**
 * Google Ads REST endpoints all live under this version path. v25 shipped
 * 2026-07-22 (v25.1 on 2026-08-19); Google's schedule sunsets it in August
 * 2027. Bump before then: https://developers.google.com/google-ads/api/docs/sunset-dates
 */
export const GOOGLE_ADS_API_VERSION = "v25";
const ADS_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

type FetchLike = typeof fetch;

// ---------------------------------------------------------------------------
// The stored / submitted account value
// ---------------------------------------------------------------------------

/**
 * Which account to query, and which account to authenticate as.
 *
 * `loginCustomerId` absent — a value saved before manager support existed.
 * The server-wide GOOGLE_ADS_LOGIN_CUSTOMER_ID (if any) still applies, so
 * those keep behaving exactly as they did.
 * `loginCustomerId === customerId` — direct access; no header is sent (Google
 * defaults it to the operating customer) and the env fallback is NOT used.
 * Anything else — reached through that manager.
 */
export type GoogleAdsAccountSelection = { customerId: string; loginCustomerId?: string };

/**
 * The picker carries one string per choice (components/ui/ResourceSelect,
 * agent configs, run inputs), so the manager rides along as
 * `"<customerId>@<loginCustomerId>"`. A bare `"1234567890"` (or
 * `"123-456-7890"`) is the pre-manager format and still parses.
 */
export function parseGoogleAdsAccountValue(value: string | null | undefined): GoogleAdsAccountSelection | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  const parts = trimmed.split("@");
  if (parts.length > 2) return null;
  const clean = (s: string) => s.replace(/^customers\//, "").replace(/[-\s]/g, "");
  const customerId = clean(parts[0]);
  if (!/^\d+$/.test(customerId)) return null;
  if (parts.length === 1) return { customerId };
  const loginCustomerId = clean(parts[1]);
  if (!/^\d+$/.test(loginCustomerId)) return null;
  return { customerId, loginCustomerId };
}

export function googleAdsAccountValue(sel: GoogleAdsAccountSelection): string {
  return sel.loginCustomerId ? `${sel.customerId}@${sel.loginCustomerId}` : sel.customerId;
}

/** 1234567890 → 123-456-7890, the way the Ads UI shows it. */
export function formatCustomerId(id: string): string {
  return /^\d{10}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id;
}

/**
 * A submitted override that adds nothing to the saved default: same customer,
 * and either no manager (a bare legacy id in an old agent config) or the same
 * manager. Returns the saved value — so a bare override never strips the
 * saved manager off. An override naming a manager the saved value doesn't
 * have returns null, so it goes through the picker listing like any other
 * unverified client string.
 */
export function sameGoogleAdsChoice(override: string, saved: string): string | null {
  const o = parseGoogleAdsAccountValue(override);
  const s = parseGoogleAdsAccountValue(saved);
  if (!o || !s || o.customerId !== s.customerId) return null;
  if (o.loginCustomerId && o.loginCustomerId !== s.loginCustomerId) return null;
  return googleAdsAccountValue(s);
}

/**
 * Find the picker option a submitted value means: the exact value first, else
 * the option for the same customer (a bare legacy id, or a manager path that
 * has since been replaced by a better one — either way the grant can reach
 * that customer, and the option carries the path that works).
 */
export function matchGoogleAdsOption<T extends { value: string }>(options: T[], value: string): T | undefined {
  const wanted = parseGoogleAdsAccountValue(value);
  if (!wanted) return undefined;
  const canonical = googleAdsAccountValue(wanted);
  const exact = options.find((o) => o.value === canonical);
  if (exact) return exact;
  return options.find((o) => parseGoogleAdsAccountValue(o.value)?.customerId === wanted.customerId);
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

export const DEVELOPER_TOKEN_MISSING =
  "GOOGLE_ADS_DEVELOPER_TOKEN is not configured on this server — Google Ads needs an approved developer token before any account can be read. An administrator must set it (see https://ads.google.com/aw/apicenter).";

export function buildGoogleAdsHeaders(opts: {
  accessToken: string;
  developerToken?: string;
  /** The customer in the URL. Only needed to recognise direct access. */
  customerId?: string;
  loginCustomerId?: string;
  /** Server-wide GOOGLE_ADS_LOGIN_CUSTOMER_ID — used only when the selection names no login at all. */
  fallbackLoginCustomerId?: string;
}): Record<string, string> {
  if (!opts.developerToken) throw new Error(DEVELOPER_TOKEN_MISSING);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.accessToken}`,
    "developer-token": opts.developerToken,
    "Content-Type": "application/json",
  };
  const login = opts.loginCustomerId?.replace(/\D/g, "");
  if (login) {
    // Direct access: Google's docs say the header isn't needed and defaults
    // to the operating customer. Omitting it also keeps a server-wide
    // fallback manager from being sent for an account it doesn't manage.
    if (login !== opts.customerId?.replace(/\D/g, "")) headers["login-customer-id"] = login;
  } else if (opts.fallbackLoginCustomerId) {
    headers["login-customer-id"] = opts.fallbackLoginCustomerId.replace(/\D/g, "");
  }
  return headers;
}

/**
 * Headers for one Google Ads call, reading the developer token and fallback
 * manager from the environment. Pass the selection being queried — its
 * manager becomes `login-customer-id`. No selection (e.g.
 * listAccessibleCustomers, which isn't scoped to a customer) → the env
 * fallback applies, as before.
 */
export function googleAdsHeaders(
  accessToken: string,
  selection?: GoogleAdsAccountSelection | string | null,
): Record<string, string> {
  const sel = typeof selection === "string" ? parseGoogleAdsAccountValue(selection) : selection ?? null;
  return buildGoogleAdsHeaders({
    accessToken,
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    customerId: sel?.customerId,
    loginCustomerId: sel?.loginCustomerId,
    fallbackLoginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
  });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A failed Google Ads call. `known` errors carry a message and hint a person
 * can act on; unknown ones keep the raw `Google Ads API <status>: <body>`
 * shape the handlers produced before.
 */
export class GoogleAdsApiError extends Error {
  readonly status: number;
  /** Google's error enum, e.g. USER_PERMISSION_DENIED, when one was found. */
  readonly errorCode: string | null;
  readonly hint: string;
  readonly known: boolean;
  /** An error that applies to every account on this grant/server, so listing more accounts is pointless. */
  readonly fatal: boolean;
  constructor(init: { message: string; status: number; errorCode: string | null; hint: string; known: boolean; fatal: boolean }) {
    super(init.message);
    this.name = "GoogleAdsApiError";
    this.status = init.status;
    this.errorCode = init.errorCode;
    this.hint = init.hint;
    this.known = init.known;
    this.fatal = init.fatal;
  }
}

/** Every `errorCode` enum value in a Google Ads REST error body (object or searchStream's array form). */
export function googleAdsErrorCodes(bodyText: string): string[] {
  const codes: string[] = [];
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const bodies = Array.isArray(parsed) ? parsed : [parsed];
    for (const body of bodies) {
      const details = (body as { error?: { details?: Array<{ errors?: Array<{ errorCode?: Record<string, unknown> }> }> } })?.error?.details ?? [];
      for (const detail of details) {
        for (const e of detail.errors ?? []) {
          for (const v of Object.values(e.errorCode ?? {})) if (typeof v === "string") codes.push(v);
        }
      }
      const reason = (body as { error?: { details?: Array<{ reason?: unknown }> } })?.error?.details?.find((d) => typeof d.reason === "string")?.reason;
      if (typeof reason === "string") codes.push(reason);
    }
  } catch {
    // Not JSON (an HTML proxy page, a truncated body) — fall through to the text checks below.
  }
  return codes;
}

export function googleAdsError(status: number, bodyText: string, sel?: GoogleAdsAccountSelection | null): GoogleAdsApiError {
  const codes = googleAdsErrorCodes(bodyText);
  const has = (code: string) => codes.includes(code) || bodyText.includes(code);
  const account = sel ? `Google Ads account ${formatCustomerId(sel.customerId)}` : "the Google Ads account";
  const viaManager = sel?.loginCustomerId && sel.loginCustomerId !== sel.customerId ? ` through manager account ${formatCustomerId(sel.loginCustomerId)}` : "";
  const known = (errorCode: string, message: string, hint: string, fatal = false) =>
    new GoogleAdsApiError({ message, status, errorCode, hint, known: true, fatal });

  if (has("DEVELOPER_TOKEN_NOT_APPROVED") || /only approved for use with test accounts/i.test(bodyText)) {
    return known(
      "DEVELOPER_TOKEN_NOT_APPROVED",
      "This app's Google Ads developer token only has Test access, so Google won't let it read real (non-test) Ads accounts.",
      "An administrator of this app must upgrade the developer token to Explorer, Basic or Standard access in the Google Ads API Center (ads.google.com/aw/apicenter). Nothing on your own Google account needs to change, and reconnecting won't help.",
      true,
    );
  }
  if (has("DEVELOPER_TOKEN_INVALID") || has("DEVELOPER_TOKEN_PROHIBITED") || has("DEVELOPER_TOKEN_PARAMETER_MISSING")) {
    return known(
      codes.find((c) => c.startsWith("DEVELOPER_TOKEN")) ?? "DEVELOPER_TOKEN_INVALID",
      "Google rejected this app's Google Ads developer token.",
      "An administrator of this app must check GOOGLE_ADS_DEVELOPER_TOKEN against the Google Ads API Center (ads.google.com/aw/apicenter) and the Google Cloud project it's tied to. Reconnecting won't help.",
      true,
    );
  }
  if (has("SERVICE_DISABLED") || /Google Ads API has not been used in project|googleads\.googleapis\.com.*disabled/i.test(bodyText)) {
    return known(
      "SERVICE_DISABLED",
      "The Google Ads API isn't enabled in this app's Google Cloud project.",
      "An administrator of this app must enable the Google Ads API in the Google Cloud project that owns the OAuth client, then try again.",
      true,
    );
  }
  if (has("NOT_ADS_USER")) {
    return known(
      "NOT_ADS_USER",
      "The Google login that was connected isn't a user on any Google Ads account.",
      "Reconnect Google Ads and sign in with the Google login you use at ads.google.com — one that's a user on the Ads account itself or on the manager (MCC) account above it.",
      true,
    );
  }
  if (has("USER_PERMISSION_DENIED")) {
    return known(
      "USER_PERMISSION_DENIED",
      `The connected Google login doesn't have permission to read ${account}${viaManager}.`,
      "If this account sits under a manager (MCC) account, choose it again from the Google Ads account list — client accounts are listed \"via\" their manager so requests go through it. Otherwise reconnect with a Google login that has access to the account or its manager.",
    );
  }
  if (has("CUSTOMER_NOT_ENABLED")) {
    return known(
      "CUSTOMER_NOT_ENABLED",
      `${account[0].toUpperCase()}${account.slice(1)} is cancelled, closed, or not finished setting up.`,
      "Choose an active account from the Google Ads account list.",
    );
  }
  if (has("REQUESTED_METRICS_FOR_MANAGER")) {
    return known(
      "REQUESTED_METRICS_FOR_MANAGER",
      `${account[0].toUpperCase()}${account.slice(1)} is a manager (MCC) account, which has no campaigns or metrics of its own.`,
      "Choose one of the client accounts under it from the Google Ads account list.",
    );
  }
  return new GoogleAdsApiError({
    message: `Google Ads API ${status}: ${bodyText.slice(0, 300)}`,
    status,
    errorCode: codes[0] ?? null,
    hint: "Reconnect Google Ads on the Integrations page, or confirm the selected account still exists and still grants access.",
    known: false,
    fatal: false,
  });
}

/** One line for a route or connect page to show: the message, plus the hint when there is one. */
export function describeGoogleAdsError(err: unknown): string {
  if (err instanceof GoogleAdsApiError && err.known) return `${err.message} ${err.hint}`;
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

async function timedFetch(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export type GoogleAdsDeps = {
  fetch?: FetchLike;
  developerToken?: string;
  fallbackLoginCustomerId?: string;
  timeoutMs?: number;
};

function headersFor(accessToken: string, sel: GoogleAdsAccountSelection | null, deps: GoogleAdsDeps) {
  return buildGoogleAdsHeaders({
    accessToken,
    developerToken: deps.developerToken ?? process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    customerId: sel?.customerId,
    loginCustomerId: sel?.loginCustomerId,
    fallbackLoginCustomerId: "fallbackLoginCustomerId" in deps ? deps.fallbackLoginCustomerId : process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
  });
}

/** Raw searchStream: every chunk, or a GoogleAdsApiError. */
async function searchStreamRaw<T>(accessToken: string, sel: GoogleAdsAccountSelection, query: string, deps: GoogleAdsDeps): Promise<T[]> {
  const res = await timedFetch(
    deps.fetch ?? fetch,
    `${ADS_BASE}/customers/${sel.customerId}/googleAds:searchStream`,
    { method: "POST", headers: headersFor(accessToken, sel, deps), body: JSON.stringify({ query }) },
    deps.timeoutMs ?? 60_000,
  );
  const text = await res.text();
  if (!res.ok) throw googleAdsError(res.status, text, sel);
  const parsed = text ? (JSON.parse(text) as unknown) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]) as T[];
}

/**
 * GAQL via searchStream for an agent handler, with the selection's own
 * manager as `login-customer-id`. A recognised failure (test-only developer
 * token, permission denied, not an Ads user…) becomes an AgentInputError with
 * a hint a person can act on — handlers already rethrow those as-is. Anything
 * else stays a plain Error, which the handlers wrap in liveCallFailed.
 */
export async function googleAdsSearchStream<T>(
  accessToken: string,
  sel: GoogleAdsAccountSelection,
  query: string,
  deps: GoogleAdsDeps = {},
): Promise<T[]> {
  try {
    return await searchStreamRaw<T>(accessToken, sel, query, deps);
  } catch (err) {
    if (err instanceof GoogleAdsApiError && err.known) throw new AgentInputError(err.message, err.hint, "integration_call_failed");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The account picker
// ---------------------------------------------------------------------------

export type GoogleAdsAccountOption = { value: string; label: string; detail?: string };

type CustomerClientRow = {
  customerClient?: {
    clientCustomer?: string;
    id?: string;
    descriptiveName?: string;
    manager?: boolean;
    level?: string | number;
    status?: string;
    currencyCode?: string;
  };
};

export type ListGoogleAdsAccountsOptions = GoogleAdsDeps & {
  /** How far below each accessible account to look. Agency → sub-MCC → client is level 2. */
  maxLevel?: number;
  /** Accessible accounts to expand (each costs one query). */
  maxAccessible?: number;
  /** Selectable accounts returned, in total. */
  maxAccounts?: number;
  /** Parallel customer_client queries. */
  concurrency?: number;
  /** Wall-clock budget for the whole listing; accounts not reached in time are offered bare. */
  budgetMs?: number;
  now?: () => number;
};

const HIDDEN_STATUSES = new Set(["CANCELED", "CANCELLED", "CLOSED"]);

/**
 * Every active, non-manager Google Ads account this grant can query, each
 * carrying the manager to authenticate through.
 *
 * 1. listAccessibleCustomers — accounts the login is directly a user on.
 * 2. For each, `customer_client` rows down to `maxLevel`, queried with
 *    login-customer-id = that account. For a plain account that's just
 *    itself (and gives its name); for a manager it's the whole tree.
 * 3. Dedupe by client id: direct access beats going through a manager, a
 *    nearer manager beats a farther one, and otherwise the first (accessible
 *    ids are walked in sorted order, so the choice is stable).
 *
 * Manager accounts aren't offered — metrics queries on an MCC fail with
 * REQUESTED_METRICS_FOR_MANAGER. Cancelled and closed accounts are skipped.
 * An error that applies to every account (test-only developer token, not an
 * Ads user, API disabled) is thrown; one account timing out isn't — it's
 * offered bare, so a slow manager doesn't make the saved choice vanish.
 */
export async function listGoogleAdsAccounts(accessToken: string, opts: ListGoogleAdsAccountsOptions = {}): Promise<GoogleAdsAccountOption[]> {
  const fetchImpl = opts.fetch ?? fetch;
  const maxLevel = opts.maxLevel ?? 3;
  const maxAccessible = opts.maxAccessible ?? 25;
  const maxAccounts = opts.maxAccounts ?? 500;
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? 25_000);

  const listRes = await timedFetch(
    fetchImpl,
    `${ADS_BASE}/customers:listAccessibleCustomers`,
    { headers: headersFor(accessToken, null, { ...opts, fallbackLoginCustomerId: undefined }) },
    timeoutMs,
  );
  const listText = await listRes.text();
  if (!listRes.ok) throw googleAdsError(listRes.status, listText);
  const resourceNames = ((JSON.parse(listText || "{}") as { resourceNames?: string[] }).resourceNames ?? []);
  const accessible = [...new Set(resourceNames.map((rn) => rn.replace(/^customers\//, "")).filter((id) => /^\d+$/.test(id)))]
    .sort()
    .slice(0, maxAccessible);

  const query =
    "SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.manager, customer_client.level, customer_client.status, customer_client.currency_code " +
    `FROM customer_client WHERE customer_client.level <= ${maxLevel} LIMIT ${maxAccounts + 1}`;

  type Outcome = { id: string; rows: CustomerClientRow[] } | { id: string; error: unknown };
  const outcomes: Outcome[] = new Array(accessible.length);
  let next = 0;
  const worker = async () => {
    while (next < accessible.length) {
      const i = next++;
      const id = accessible[i];
      const remaining = deadline - now();
      if (remaining <= 0) {
        outcomes[i] = { id, error: new Error("listing budget exhausted") };
        continue;
      }
      try {
        const chunks = await searchStreamRaw<{ results?: CustomerClientRow[] }>(
          accessToken,
          { customerId: id, loginCustomerId: id },
          query,
          { ...opts, fetch: fetchImpl, timeoutMs: Math.min(timeoutMs, remaining) },
        );
        outcomes[i] = { id, rows: chunks.flatMap((c) => c.results ?? []) };
      } catch (err) {
        outcomes[i] = { id, error: err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, accessible.length) }, worker));

  type Candidate = { customerId: string; loginCustomerId: string; name: string; via: string | null; level: number; detail?: string };
  const best = new Map<string, Candidate>();
  const rank = (c: Candidate) => (c.via === null ? 0 : 1 + c.level);
  const offer = (c: Candidate) => {
    const current = best.get(c.customerId);
    if (!current) {
      if (best.size < maxAccounts) best.set(c.customerId, c);
      return;
    }
    if (rank(c) < rank(current)) best.set(c.customerId, c);
  };

  let firstError: unknown = null;
  for (const outcome of outcomes) {
    if (!outcome) continue;
    if ("error" in outcome) {
      const err = outcome.error;
      if (err instanceof GoogleAdsApiError && err.fatal) throw err;
      firstError ??= err;
      // A recognised per-account refusal (cancelled, no permission) would
      // fail at run time too, so it isn't offered. A timeout or an unknown
      // error might be transient: offer the account bare rather than lose it.
      if (!(err instanceof GoogleAdsApiError && err.known)) {
        offer({ customerId: outcome.id, loginCustomerId: outcome.id, name: "", via: null, level: 0, detail: "details unavailable" });
      }
      continue;
    }
    const rows = outcome.rows.map((r) => r.customerClient ?? {});
    const self = rows.find((r) => Number(r.level ?? 0) === 0);
    const managerName = self?.descriptiveName?.trim() || formatCustomerId(outcome.id);
    for (const row of rows) {
      const clientId = (row.clientCustomer ?? row.id ?? "").replace(/^customers\//, "");
      if (!/^\d+$/.test(clientId)) continue;
      if (row.manager) continue;
      const status = (row.status ?? "ENABLED").toUpperCase();
      if (HIDDEN_STATUSES.has(status)) continue;
      const direct = clientId === outcome.id;
      const detail = [row.currencyCode, status !== "ENABLED" ? status.toLowerCase() : null].filter(Boolean).join(" · ");
      offer({
        customerId: clientId,
        loginCustomerId: outcome.id,
        name: row.descriptiveName?.trim() ?? "",
        via: direct ? null : managerName,
        level: Number(row.level ?? 0),
        detail: detail || undefined,
      });
    }
  }

  if (best.size === 0 && firstError) throw firstError;

  return [...best.values()]
    .map((c) => {
      const id = formatCustomerId(c.customerId);
      const label = `${c.name ? `${c.name} (${id})` : id}${c.via ? ` · via ${c.via}` : ""}`;
      const option: GoogleAdsAccountOption = { value: googleAdsAccountValue(c), label };
      if (c.detail) option.detail = c.detail;
      return option;
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
