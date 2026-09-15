"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "@/lib/base-path";
import {
  collectionNameProblem,
  normalisePayloadBaseUrl,
  siteUrlFromDomain,
  type PayloadDiscovery,
} from "@/lib/integrations/payload-discovery";

/**
 * Two-step Payload connect. Step 1 takes only what a person can know for sure
 * (where Payload is, which collection the key's user is in, the key) and asks
 * Payload itself for the rest; step 2 offers what came back as dropdowns.
 * Free text only appears where Payload couldn't be asked (no /api/access, no
 * readable tenants).
 *
 * Saving is the unchanged POST /api/integrations/connect contract — the same
 * credential keys the KeyForm sends — so normaliseKeyCredentials and the
 * PAYLOAD verifier still have the last word.
 */

const panel: React.CSSProperties = {
  padding: "20px 20px 24px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  display: "flex",
  flexDirection: "column",
  gap: 16,
};
const fieldCol: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const hint = (color?: string): React.CSSProperties => ({ margin: 0, ...(color ? { color } : {}) });

type Found = Extract<PayloadDiscovery, { ok: true }>;

export function PayloadConnect({ name }: { name: string }) {
  const router = useRouter();

  // Step 1
  const [baseUrl, setBaseUrl] = useState("");
  const [baseTouched, setBaseTouched] = useState(false);
  const [authCollection, setAuthCollection] = useState("users");
  const [apiKey, setApiKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [found, setFound] = useState<Found | null>(null);

  // Step 2
  const [postsCollection, setPostsCollection] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [siteTouched, setSiteTouched] = useState(false);
  const [mediaCollection, setMediaCollection] = useState("");
  const [bodyFormat, setBodyFormat] = useState<"html" | "lexical">("html");
  const [bodyField, setBodyField] = useState("");
  const [bodyNote, setBodyNote] = useState("");
  const [resniffing, setResniffing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  const base = normalisePayloadBaseUrl(baseUrl);

  async function discover(posts?: string): Promise<PayloadDiscovery> {
    const res = await apiFetch("/api/integrations/payload/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, authCollection, apiKey, postsCollection: posts }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!data || typeof data.ok !== "boolean") {
      return { ok: false, step: "network", error: data?.error ?? `Request failed: ${res.status}` };
    }
    return data as PayloadDiscovery;
  }

  async function check(e: React.FormEvent) {
    e.preventDefault();
    setBaseTouched(true);
    if (!base.ok || !apiKey.trim()) return;
    setChecking(true);
    setCheckError("");
    try {
      const result = await discover();
      if (!result.ok) {
        setCheckError(result.error);
        return;
      }
      setFound(result);
      setPostsCollection(result.postsCollection ?? "");
      setMediaCollection(result.mediaCollection ?? "");
      setBodyFormat(result.body.bodyFormat);
      setBodyField(result.body.bodyField);
      setBodyNote(result.body.note);
      const only = result.tenants.available && result.tenants.options.length === 1 ? result.tenants.options[0] : null;
      setTenantId(only?.id ?? "");
      setSiteUrl(only?.siteUrl ?? "");
      setSiteTouched(false);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setChecking(false);
    }
  }

  function backToStep1() {
    setFound(null);
    setSaveError("");
  }

  async function choosePosts(slug: string) {
    setPostsCollection(slug);
    if (!slug) return;
    setResniffing(true);
    try {
      const result = await discover(slug);
      if (result.ok) {
        setBodyFormat(result.body.bodyFormat);
        setBodyField(result.body.bodyField);
        setBodyNote(result.body.note);
      }
    } finally {
      setResniffing(false);
    }
  }

  function chooseTenant(id: string) {
    setTenantId(id);
    if (!found?.tenants.available || siteTouched) return;
    setSiteUrl(found.tenants.options.find((t) => t.id === id)?.siteUrl ?? "");
  }

  const listed = found?.access.available ? found.postsCollections : null;
  const tenantOptions = found?.tenants.available ? found.tenants.options : null;
  const postsProblem = found && !listed ? collectionNameProblem(postsCollection) : null;
  const mediaProblem = found && !found.access.available ? collectionNameProblem(mediaCollection) : null;
  const siteNormalised = siteUrl.trim() ? siteUrlFromDomain(siteUrl) : null;
  const siteProblem = siteUrl.trim() && !siteNormalised ? "Enter a web address, like https://example.com" : null;
  const siteSameAsCms = found && siteNormalised && new URL(siteNormalised).host === new URL(found.baseUrl).host;
  const tenantRequired = !!found?.multiTenant;

  const step2Complete =
    !!found &&
    !!postsCollection.trim() &&
    !postsProblem &&
    !mediaProblem &&
    (!tenantRequired || !!tenantId.trim()) &&
    (!tenantRequired || !!siteNormalised) &&
    !siteProblem &&
    !!bodyField.trim();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!found || !step2Complete) return;
    setSaving(true);
    setSaveError("");
    try {
      const res = await apiFetch("/api/integrations/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "PAYLOAD",
          credentials: {
            baseUrl: found.baseUrl,
            apiKey,
            authCollection: found.authCollection,
            postsCollection: postsCollection.trim(),
            tenantId: tenantId.trim(),
            siteUrl: siteNormalised ?? "",
            bodyFormat,
            bodyField: bodyField.trim(),
            mediaCollection: mediaCollection.trim(),
          },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Request failed: ${res.status}`);
      }
      setSaved(true);
      setTimeout(() => router.push("/integrations"), 1200);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  if (!found) {
    return (
      <>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>
          Step 1 of 2 — tell us where Payload is and paste an API key. We&apos;ll ask Payload which collections and sites
          the key can reach, so you pick from a list instead of typing them.
        </p>
        <form onSubmit={check}>
          <div style={panel}>
            <div style={fieldCol}>
              <label htmlFor="payload-base" className="input-label">Payload base URL</label>
              <input
                id="payload-base"
                className={`input${baseTouched && !base.ok ? " input-error" : ""}`}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                onBlur={() => setBaseTouched(true)}
                placeholder="https://payload.example.com"
                autoComplete="off"
                inputMode="url"
              />
              {baseTouched && baseUrl.trim() ? (
                base.ok ? (
                  <p className="input-hint" style={hint()}>We&apos;ll use <strong>{base.url}</strong></p>
                ) : (
                  <p className="input-hint error" style={hint()}>{base.error}</p>
                )
              ) : (
                <p className="input-hint" style={hint()}>Where your Payload admin lives. Pasting the /admin address is fine — only the origin is used.</p>
              )}
            </div>

            <div style={fieldCol}>
              <label htmlFor="payload-auth" className="input-label">Auth collection</label>
              <input
                id="payload-auth"
                className="input"
                value={authCollection}
                onChange={(e) => setAuthCollection(e.target.value)}
                placeholder="users"
                autoComplete="off"
              />
              <p className="input-hint" style={hint()}>The collection the API key&apos;s user lives in. Almost always <code>users</code>.</p>
            </div>

            <div style={fieldCol}>
              <label htmlFor="payload-key" className="input-label">API key</label>
              <input
                id="payload-key"
                className="input"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste your API key…"
                autoComplete="off"
                style={{ fontFamily: "monospace" }}
              />
              <p className="input-hint" style={hint()}>
                On the API user&apos;s edit form in Payload: tick <strong>Enable API Key</strong>, then generate and copy it.
                The <strong>API</strong> tab on a user&apos;s page is a JSON viewer, not the key.
              </p>
            </div>

            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
              Checking only reads from Payload. Nothing is saved until step 2; the key is then encrypted with AES-256-GCM and never logged.
            </p>

            {checkError && <p style={{ fontSize: 12, color: "var(--danger, #ef4444)", margin: 0 }}>{checkError}</p>}

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button type="submit" className="btn btn-primary" disabled={checking || !base.ok || !apiKey.trim()}>
                {checking ? "Checking…" : "Check connection"}
              </button>
              <Link href="/integrations" className="btn btn-ghost">Cancel</Link>
            </div>
          </div>
        </form>
      </>
    );
  }

  return (
    <>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>
        Step 2 of 2 — connected to <strong>{found.baseUrl}</strong>
        {found.user.email ? <> as <strong>{found.user.email}</strong></> : null}.{" "}
        <button type="button" onClick={backToStep1} className="btn btn-ghost" style={{ padding: "0 4px", fontSize: 13 }}>
          Change
        </button>
      </p>

      <form onSubmit={save}>
        <div style={panel}>
          {found.warnings.map((w) => (
            <p key={w} style={{ fontSize: 12, color: "var(--warning, #b45309)", margin: 0 }}>{w}</p>
          ))}
          {!found.access.available && (
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>{found.access.reason}</p>
          )}

          <div style={fieldCol}>
            <label htmlFor="payload-posts" className="input-label">Posts collection</label>
            {listed ? (
              <select id="payload-posts" className="input" value={postsCollection} onChange={(e) => choosePosts(e.target.value)}>
                {!postsCollection && <option value="">Choose a collection…</option>}
                {listed.map((slug) => (
                  <option key={slug} value={slug}>{slug}</option>
                ))}
              </select>
            ) : (
              <input
                id="payload-posts"
                className={`input${postsProblem ? " input-error" : ""}`}
                value={postsCollection}
                onChange={(e) => setPostsCollection(e.target.value)}
                placeholder="posts"
                autoComplete="off"
              />
            )}
            {postsProblem ? (
              <p className="input-hint error" style={hint()}>{postsProblem}</p>
            ) : (
              <p className="input-hint" style={hint()}>
                {listed ? "Collections this key can read." : "The collection's name (usually posts) — not a single post's slug."}
              </p>
            )}
          </div>

          {tenantOptions && tenantOptions.length > 0 ? (
            <div style={fieldCol}>
              <label htmlFor="payload-tenant" className="input-label">Site (tenant)</label>
              <select id="payload-tenant" className="input" value={tenantId} onChange={(e) => chooseTenant(e.target.value)}>
                {!tenantId && <option value="">Choose the site these posts belong to…</option>}
                {tenantOptions.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
              <p className="input-hint" style={hint()}>Tenants this key can see. Posts are read from and published to this one only.</p>
            </div>
          ) : found.multiTenant || (found.tenants.available === false && found.tenants.reason) ? (
            <div style={fieldCol}>
              <label htmlFor="payload-tenant" className="input-label">Tenant ID</label>
              <input
                id="payload-tenant"
                className="input"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                placeholder="e.g. 3"
                autoComplete="off"
              />
              <p className="input-hint" style={hint()}>
                {found.tenants.available === false && found.tenants.reason ? `${found.tenants.reason} ` : ""}
                It&apos;s the id in the address bar when you open the tenant in Payload (…/admin/collections/tenants/<strong>3</strong>).
              </p>
            </div>
          ) : null}

          <div style={fieldCol}>
            <label htmlFor="payload-site" className="input-label">Public site URL</label>
            <input
              id="payload-site"
              className={`input${siteProblem ? " input-error" : ""}`}
              value={siteUrl}
              onChange={(e) => {
                setSiteUrl(e.target.value);
                setSiteTouched(true);
              }}
              placeholder="https://example.com"
              autoComplete="off"
              inputMode="url"
            />
            {siteProblem ? (
              <p className="input-hint error" style={hint()}>{siteProblem}</p>
            ) : siteNormalised ? (
              <p className="input-hint" style={hint()}>
                Links to posts will start with <strong>{siteNormalised}</strong>
                {siteSameAsCms ? " — that's the CMS host; posts usually render on a different domain." : "."}
              </p>
            ) : (
              <p className="input-hint" style={hint(tenantRequired ? "var(--danger, #ef4444)" : undefined)}>
                {tenantRequired
                  ? "Required — where this site's posts are actually published."
                  : `Where posts are published. Left blank, links are built on ${found.baseUrl}.`}
              </p>
            )}
          </div>

          <div style={fieldCol}>
            <label htmlFor="payload-media" className="input-label">Media collection</label>
            {found.access.available && found.mediaCollections.length > 0 ? (
              <select id="payload-media" className="input" value={mediaCollection} onChange={(e) => setMediaCollection(e.target.value)}>
                {!mediaCollection && <option value="">Default (media)</option>}
                {found.mediaCollections.map((slug) => (
                  <option key={slug} value={slug}>{slug}</option>
                ))}
              </select>
            ) : (
              <input
                id="payload-media"
                className={`input${mediaProblem ? " input-error" : ""}`}
                value={mediaCollection}
                onChange={(e) => setMediaCollection(e.target.value)}
                placeholder="media"
                autoComplete="off"
              />
            )}
            <p className={`input-hint${mediaProblem ? " error" : ""}`} style={hint()}>
              {mediaProblem ?? "Where Blog Writer uploads generated images."}
            </p>
          </div>

          <details open={bodyFormat === "lexical" || !bodyField}>
            <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--text-muted)" }}>
              Advanced — body field: {bodyField || "?"} ({bodyFormat}){resniffing ? " · checking…" : ""}
            </summary>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
              {bodyNote && <p className="input-hint" style={hint()}>{bodyNote}</p>}
              <div style={fieldCol}>
                <label htmlFor="payload-body-format" className="input-label">Body format</label>
                <select
                  id="payload-body-format"
                  className="input"
                  value={bodyFormat}
                  onChange={(e) => setBodyFormat(e.target.value as "html" | "lexical")}
                >
                  <option value="html">HTML string (publishing supported)</option>
                  <option value="lexical">Lexical rich text (internal linking only)</option>
                </select>
              </div>
              <div style={fieldCol}>
                <label htmlFor="payload-body-field" className="input-label">Body field name</label>
                <input
                  id="payload-body-field"
                  className="input"
                  value={bodyField}
                  onChange={(e) => setBodyField(e.target.value)}
                  placeholder={bodyFormat === "lexical" ? "content" : "bodyHtml"}
                  autoComplete="off"
                />
              </div>
            </div>
          </details>

          {saveError && <p style={{ fontSize: 12, color: "var(--danger, #ef4444)", margin: 0 }}>{saveError}</p>}
          {saved && <p style={{ fontSize: 12, color: "var(--success, #22c55e)", margin: 0 }}>Connected! Redirecting…</p>}

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button type="submit" className="btn btn-primary" disabled={saving || saved || resniffing || !step2Complete}>
              {saving ? "Saving…" : `Connect ${name}`}
            </button>
            <button type="button" className="btn btn-ghost" onClick={backToStep1}>Back</button>
          </div>
        </div>
      </form>
    </>
  );
}
