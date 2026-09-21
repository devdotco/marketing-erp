import type { EngineCitation } from "./types";

/**
 * The bare host of a URL, lowercased, without "www.".
 *
 * Used both to group citations by domain and to decide whether a citation is
 * the workspace's own site. Returns null rather than throwing on junk, because
 * engines do occasionally hand back a relative or malformed URL and losing one
 * citation is better than losing the capture.
 */
export function hostOf(url: string): string | null {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * Dedupe citations by URL, keeping first appearance.
 *
 * Every engine repeats a source it leans on. Counting each repeat would make
 * one heavily-quoted page look like several, which is precisely the number the
 * citation-authority view is supposed to get right.
 */
export function dedupeCitations(raw: Array<{ url: string; title?: string }>): EngineCitation[] {
  const seen = new Set<string>();
  const out: EngineCitation[] = [];
  for (const item of raw) {
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, title: item.title, position: out.length + 1 });
  }
  return out;
}

/** Narrow an unknown JSON value to a record without `as any` at every call site. */
export function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
