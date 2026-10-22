/**
 * Deterministic checks on the Repurposer's output.
 *
 * The 2026-10-21 QA run on a DEV.co article showed the reviewer could not tell
 * which figures came from the source and which the model added ("Lovable $6.6B
 * to $13.3B", a named CEO quote), that one number drifted between formats
 * ("$2.6 billion" vs "$2.69B"), that the model's own character counts were
 * wrong, and that a video scene packed 28 words into 8 seconds. The prompt
 * now forbids all of it; these checks catch what the model does anyway.
 *
 * Pure functions, no network or database, so test/repurpose-check.test.ts runs
 * them directly.
 */

/** Words per second the video budget is written to (150 wpm). */
export const SPOKEN_WORDS_PER_SECOND = 2.5;
/** Above this a scene is rushed; the prompt targets 150, so this leaves headroom. */
export const MAX_SCENE_WPM = 170;
/** X counts every URL as this many characters, whatever its length. */
export const X_URL_CHARS = 23;
export const X_POST_LIMIT = 280;
/** The closing CTA scene must start within this many seconds of the end. */
export const CTA_WINDOW_SECONDS = 8;

const SKIP_KEYS = new Set(["generatedAt", "workspaceId", "_review", "_provenance"]);

/** Every string in the output with a readable path, so a warning can say where. */
export function collectStrings(value: unknown, path = ""): Array<{ path: string; text: string }> {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => collectStrings(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !SKIP_KEYS.has(k))
      .flatMap(([k, v]) => collectStrings(v, path ? `${path}.${k}` : k));
  }
  return [];
}

const URL_RE = /https?:\/\/[^\s)\]>"'`]+/gi;

/** A URL with sentence punctuation and a trailing slash removed, for comparison. */
export function cleanUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/, "").replace(/\/+$/, "");
}

// A dollar sign, or a digit not glued to a letter ("B2B" must not read as 2 billion);
// then an optional unit. A bare number with neither "$" nor a unit is not a claim.
const FIGURE_RE =
  /(?:(\$)|(?<![\w.]))(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:(\s?%)|\s(thousand|million|billion|trillion|percent)\b|(bn|[KkMmBbTt])(?![A-Za-z0-9]))?/g;
const QUARTER_RE = /\bQ([1-4])\s?(20\d\d)\b/gi;

const MULTIPLIER: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12,
};

export interface Figure {
  /** Canonical value, so "$2.69B", "$2.69 billion" and "2.69B" share one key. */
  key: string;
  /** As written, for the warning. */
  text: string;
}

export function extractFigures(input: string): Figure[] {
  const text = input.replace(URL_RE, " ");
  const found: Figure[] = [];

  for (const m of text.matchAll(FIGURE_RE)) {
    const [whole, dollar, int, frac, pctSym, word, letter] = m;
    const unit = (word ?? letter ?? "").toLowerCase();
    const isPct = !!pctSym || unit === "percent";
    if (!dollar && !isPct && !unit) continue;
    const base = Number(`${int.replace(/,/g, "")}${frac ?? ""}`);
    const value = Number((base * (MULTIPLIER[unit] ?? 1)).toPrecision(12));
    found.push({ key: `${value}${isPct ? "%" : ""}`, text: whole.trim() });
  }
  for (const m of text.matchAll(QUARTER_RE)) {
    found.push({ key: `q${m[1]} ${m[2]}`, text: m[0] });
  }
  return found;
}

/**
 * Figures in the output that the source text does not contain. With no source
 * text there is nothing to check against, so the reviewer is told that
 * instead of being shown a clean result.
 */
export function figureWarnings(output: unknown, sourceText: string): string[] {
  const strings = collectStrings(output);
  if (!sourceText.trim()) {
    const all = new Map<string, string>();
    for (const s of strings) for (const f of extractFigures(s.text)) if (!all.has(f.key)) all.set(f.key, f.text);
    if (all.size === 0) return [];
    return [
      `No article text was supplied, so every figure here is unverifiable (${[...all.values()].slice(0, 8).join(", ")}${all.size > 8 ? ", …" : ""}). Check each against the real article before approving.`,
    ];
  }

  const known = new Set(extractFigures(sourceText).map((f) => f.key));
  const warned = new Set<string>();
  const warnings: string[] = [];
  for (const s of strings) {
    for (const f of extractFigures(s.text)) {
      if (known.has(f.key) || warned.has(f.key)) continue;
      warned.add(f.key);
      warnings.push(`"${f.text}" (${s.path}) does not appear in the source article. It may have been added by the model, or its format drifted from the source.`);
    }
  }
  return warnings;
}

/** Length as X counts it: code points, with each URL fixed at 23. */
export function xCharCount(text: string): number {
  return [...text.replace(URL_RE, "x".repeat(X_URL_CHARS))].length;
}

/**
 * Overwrites the model's character counts with real ones and sets totalPosts.
 * Mutates the thread in place; returns warnings for posts over the limit.
 */
export function applyThreadCounts(thread: unknown): string[] {
  if (!thread || typeof thread !== "object") return [];
  const t = thread as Record<string, unknown>;
  const warnings: string[] = [];

  if (typeof t.hook === "string") {
    t.hookCharCount = xCharCount(t.hook);
    if ((t.hookCharCount as number) > X_POST_LIMIT) warnings.push(`The X thread hook is ${t.hookCharCount} characters (limit ${X_POST_LIMIT}).`);
  }
  if (Array.isArray(t.posts)) {
    t.posts.forEach((p, i) => {
      if (!p || typeof p !== "object") return;
      const post = p as Record<string, unknown>;
      if (typeof post.text !== "string") return;
      post.charCount = xCharCount(post.text);
      if ((post.charCount as number) > X_POST_LIMIT) warnings.push(`X post ${i + 1} is ${post.charCount} characters (limit ${X_POST_LIMIT}).`);
    });
    t.totalPosts = t.posts.length;
  }
  return warnings;
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Per-scene spoken-word budget for the prompt: duration x 2.5, rounded. */
export function wordBudget(seconds: number): number {
  return Math.round(seconds * SPOKEN_WORDS_PER_SECOND);
}

/**
 * Pacing and tiling of the video script. A scene's `seconds` is its start
 * time, so its duration is the gap to the next scene; the last runs to
 * totalSeconds.
 */
export function videoWarnings(video: unknown, expectedTotal: number): string[] {
  if (!video || typeof video !== "object") return [];
  const v = video as Record<string, unknown>;
  const scenes = Array.isArray(v.scenes) ? (v.scenes as Array<Record<string, unknown>>) : [];
  if (scenes.length === 0) return [];

  const warnings: string[] = [];
  const total = typeof v.totalSeconds === "number" ? v.totalSeconds : expectedTotal;
  if (total !== expectedTotal) warnings.push(`The video script says it runs ${total}s but ${expectedTotal}s was requested.`);

  const starts = scenes.map((s) => (typeof s.seconds === "number" ? s.seconds : NaN));
  if (starts.some(Number.isNaN)) {
    warnings.push("A video scene has no start time, so its pacing could not be checked.");
    return warnings;
  }
  if (starts[0] !== 0) warnings.push(`The first video scene starts at ${starts[0]}s, not 0s, so the scenes do not tile from the start.`);
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] <= starts[i - 1]) {
      warnings.push(`Video scene ${i + 1} starts at ${starts[i]}s, which is not after scene ${i} (${starts[i - 1]}s).`);
    }
  }
  const last = starts[starts.length - 1];
  if (last >= total) warnings.push(`The last video scene starts at ${last}s, at or past the ${total}s end, so it has no time to run.`);
  else if (last < total - CTA_WINDOW_SECONDS) {
    warnings.push(`The video has no closing scene: the last one starts at ${last}s, more than ${CTA_WINDOW_SECONDS}s before the ${total}s end, so the scenes do not reach ${total}s with a CTA.`);
  }

  scenes.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : total;
    const duration = end - starts[i];
    const words = wordCount(typeof s.script === "string" ? s.script : "");
    if (duration <= 0) return; // already reported above
    const wpm = (words / duration) * 60;
    if (wpm > MAX_SCENE_WPM) {
      warnings.push(`Video scene ${i + 1} has ${words} words in ${duration}s (about ${Math.round(wpm)} wpm), too fast to speak. Keep it near 150 wpm (${wordBudget(duration)} words).`);
    }
  });
  return warnings;
}

/**
 * Warns when a URL in the output is not the supplied source URL. URLs that
 * appear in the source text are genuine quotes and are ignored; what is left
 * is almost always a reconstructed or hallucinated slug.
 */
export function urlWarnings(output: unknown, sourceUrl: string, sourceText: string): string[] {
  if (!sourceUrl) return [];
  const want = cleanUrl(sourceUrl);
  const quoted = new Set((sourceText.match(URL_RE) ?? []).map(cleanUrl));
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const s of collectStrings(output)) {
    for (const raw of s.text.match(URL_RE) ?? []) {
      const url = cleanUrl(raw);
      if (url === want || quoted.has(url) || seen.has(url)) continue;
      seen.add(url);
      warnings.push(`${url} (${s.path}) is not the source URL you supplied (${want}). Use the supplied URL verbatim.`);
    }
  }
  return warnings;
}

/** The X thread must end on the source URL (CTA); flagged if it is absent. */
export function threadCtaWarnings(thread: unknown, sourceUrl: string): string[] {
  if (!sourceUrl || !thread || typeof thread !== "object") return [];
  const posts = (thread as Record<string, unknown>).posts;
  if (!Array.isArray(posts) || posts.length === 0) return [];
  const last = posts[posts.length - 1] as Record<string, unknown>;
  const text = typeof last?.text === "string" ? last.text : "";
  return text.includes(cleanUrl(sourceUrl)) ? [] : ["The last X post does not contain the source URL, so the thread has no link to click."];
}

/**
 * Runs every check. Mutates xThread (counts) and returns the warnings.
 * Call after parsing and before attaching the review.
 */
export function repurposeWarnings(
  output: Record<string, unknown>,
  opts: { sourceUrl: string; sourceText: string; videoSeconds: number },
): string[] {
  return [
    ...applyThreadCounts(output.xThread),
    ...threadCtaWarnings(output.xThread, opts.sourceUrl),
    ...videoWarnings(output.videoScript, opts.videoSeconds),
    ...urlWarnings(output, opts.sourceUrl, opts.sourceText),
    ...figureWarnings(output, opts.sourceText),
  ];
}
