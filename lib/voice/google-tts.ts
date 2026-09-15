/**
 * Google text-to-speech for the Podcast agent, through the Gemini API's native
 * TTS models — the alternative voice provider to Cartesia.
 *
 * Why this Google offering and not the others (researched 2026-09-15):
 * - Gemini API TTS takes a plain API key from Google AI Studio
 *   (aistudio.google.com/apikey), sent as `x-goog-api-key`. No service
 *   account, no OAuth consent, and it does two-voice dialogue natively.
 *   https://ai.google.dev/gemini-api/docs/generate-content/speech-generation
 * - Cloud Text-to-Speech (texttospeech.googleapis.com) has the same Gemini
 *   voices plus MP3 output, but its docs only describe OAuth/ADC credentials
 *   with an `x-goog-user-project` header, and it needs a Cloud project with
 *   billing before the first call. https://docs.cloud.google.com/text-to-speech/docs/gemini-tts
 *   Carrying the `cloud-platform` scope on our existing Google OAuth app would
 *   not remove that project/billing setup, and adds a sensitive scope to it.
 * - NotebookLM Enterprise's Podcast API writes its own script from sources
 *   (no voice or host control) and is deprecated with no new allowlisting.
 *   https://docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/podcast-api
 *
 * The contract, as documented (Google now labels generateContent "Legacy" next
 * to its newer Interactions API, but it is the documented, SDK-typed shape —
 * SpeechConfig / MultiSpeakerVoiceConfig in @google/genai):
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *   x-goog-api-key: <key>
 *   { contents: [{ parts: [{ text }] }],
 *     generationConfig: { responseModalities: ["AUDIO"],
 *       speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
 *       // or, for exactly two speakers:
 *       speechConfig: { multiSpeakerVoiceConfig: { speakerVoiceConfigs: [
 *         { speaker, voiceConfig: { prebuiltVoiceConfig: { voiceName } } }, … ] } } } }
 *   → candidates[0].content.parts[0].inlineData { mimeType: "audio/L16;codec=pcm;rate=24000", data: base64 }
 *
 * Output is raw 16-bit little-endian mono PCM at 24 kHz — there is no MP3
 * option on this API — so chunks are concatenated as PCM (exact, no seams from
 * container headers) and encoded to MP3 once, in lib/voice/mp3.ts.
 *
 * Limits: 32k-token session context; gemini-3.1-flash-tts-preview takes 8,192
 * input tokens and emits at most 16,384 audio tokens (25 tokens per second, so
 * roughly 11 minutes). Google also warns quality "may drift" past a few
 * minutes and recommends splitting long transcripts — hence chunkNarration.
 *
 * Server-side only by use, but has no server imports: the network call takes
 * an injectable fetch so every branch here is unit-testable.
 */

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Form label → model id. The first entry is the default. */
export const GOOGLE_TTS_MODELS = [
  { label: "Gemini 3.1 Flash TTS (recommended)", id: "gemini-3.1-flash-tts-preview" },
  { label: "Gemini 2.5 Pro TTS (highest fidelity)", id: "gemini-2.5-pro-preview-tts" },
  { label: "Gemini 2.5 Flash TTS (lowest cost)", id: "gemini-2.5-flash-preview-tts" },
] as const;

export type GoogleTtsModelId = (typeof GOOGLE_TTS_MODELS)[number]["id"];

export const GOOGLE_TTS_DEFAULT_MODEL: GoogleTtsModelId = GOOGLE_TTS_MODELS[0].id;
export const GOOGLE_TTS_MODEL_OPTIONS = GOOGLE_TTS_MODELS.map((m) => m.label);

/**
 * USD per 1M tokens, from https://ai.google.dev/gemini-api/docs/pricing
 * (fetched 2026-09-15). Output is audio tokens. Billed to the customer's own
 * Google account; used only to report the run's cost.
 */
const GOOGLE_TTS_PRICING: Record<GoogleTtsModelId, { input: number; output: number }> = {
  "gemini-3.1-flash-tts-preview": { input: 1, output: 20 },
  "gemini-2.5-pro-preview-tts": { input: 1, output: 20 },
  "gemini-2.5-flash-preview-tts": { input: 0.5, output: 10 },
};

/** The 30 prebuilt voices and Google's one-word description of each. */
export const GOOGLE_VOICES = [
  ["Zephyr", "Bright"], ["Puck", "Upbeat"], ["Charon", "Informative"], ["Kore", "Firm"],
  ["Fenrir", "Excitable"], ["Leda", "Youthful"], ["Orus", "Firm"], ["Aoede", "Breezy"],
  ["Callirrhoe", "Easy-going"], ["Autonoe", "Bright"], ["Enceladus", "Breathy"], ["Iapetus", "Clear"],
  ["Umbriel", "Easy-going"], ["Algieba", "Smooth"], ["Despina", "Smooth"], ["Erinome", "Clear"],
  ["Algenib", "Gravelly"], ["Rasalgethi", "Informative"], ["Laomedeia", "Upbeat"], ["Achernar", "Soft"],
  ["Alnilam", "Firm"], ["Schedar", "Even"], ["Gacrux", "Mature"], ["Pulcherrima", "Forward"],
  ["Achird", "Friendly"], ["Zubenelgenubi", "Casual"], ["Vindemiatrix", "Gentle"], ["Sadachbia", "Lively"],
  ["Sadaltager", "Knowledgeable"], ["Sulafat", "Warm"],
] as const;

export const GOOGLE_VOICE_OPTIONS = GOOGLE_VOICES.map(([name, style]) => `${name} — ${style}`);
export const GOOGLE_DEFAULT_VOICE = "Charon — Informative";
export const GOOGLE_DEFAULT_SECOND_VOICE = "Aoede — Breezy";

const VOICE_NAMES = new Set<string>(GOOGLE_VOICES.map(([name]) => name));

/**
 * "Kore — Firm" (the form label) or a bare "kore" → "Kore". Anything that is
 * not one of the prebuilt voices falls back, so an arbitrary string never
 * reaches the request.
 */
export function googleVoiceName(raw: string | undefined, fallback: string = GOOGLE_DEFAULT_VOICE): string {
  const pick = (value: string | undefined) => {
    const word = (value ?? "").trim().match(/^[A-Za-z]+/)?.[0]?.toLowerCase();
    if (!word) return null;
    return [...VOICE_NAMES].find((name) => name.toLowerCase() === word) ?? null;
  };
  return pick(raw) ?? pick(fallback) ?? "Charon";
}

/** Form label or model id → a model id from the allowlist. */
export function googleTtsModelId(raw: string | undefined): GoogleTtsModelId {
  const value = (raw ?? "").trim();
  const match = GOOGLE_TTS_MODELS.find((m) => m.label === value || m.id === value);
  return match?.id ?? GOOGLE_TTS_DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// Script → speakable text
// ---------------------------------------------------------------------------

/**
 * The script writer marks [PAUSE], [EMPHASIS] and [TRANSITION] for a human
 * reader. Gemini treats bracketed words as free-form audio tags and may speak
 * unknown ones, so pauses become an ellipsis and the rest are dropped, along
 * with markdown emphasis/headings.
 */
export function cleanScriptForSpeech(script: string): string {
  return script
    .replace(/\[\s*pause\s*\]/gi, "…")
    .replace(/\[\s*(emphasis|transition|music[^\]]*|sfx[^\]]*|sound[^\]]*)\s*\]/gi, "")
    .replace(/\*\*|__/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type DialogueLine = { speaker: string; text: string };

/** The two speaker labels the script writer is told to use for a two-voice episode. */
export function dialogueSpeakers(hostStyle: string): [string, string] | null {
  if (hostStyle === "Two co-hosts") return ["Host", "CoHost"];
  if (hostStyle === "Interview") return ["Host", "Guest"];
  return null;
}

/**
 * Split a labelled script ("Host: …" / "Guest: …") into turns. A line with no
 * label continues the previous turn. Returns null unless both speakers
 * actually speak — the caller then voices the whole script with one voice
 * rather than sending a "conversation" with one side to a two-voice config.
 */
export function parseDialogue(script: string, speakers: [string, string]): DialogueLine[] | null {
  const escaped = speakers.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const label = new RegExp(`^[\\s*_]*(${escaped.join("|")})[\\s*_]*[:：][\\s*_]*(.*)$`, "i");
  const lines: DialogueLine[] = [];
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(label);
    if (m) {
      const speaker = speakers.find((s) => s.toLowerCase() === m[1].toLowerCase())!;
      lines.push({ speaker, text: m[2].trim() });
    } else if (lines.length > 0) {
      const last = lines[lines.length - 1];
      last.text = last.text ? `${last.text} ${line}` : line;
    } else {
      lines.push({ speaker: speakers[0], text: line });
    }
  }
  const spoken = lines.filter((l) => l.text);
  const who = new Set(spoken.map((l) => l.speaker));
  return who.size === 2 ? spoken : null;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * ~3,000 characters is ~500 spoken words, a little over three minutes of
 * audio: far inside the 8,192-token input and ~11-minute output ceilings, and
 * short enough that Google's "quality may drift" warning doesn't bite.
 */
export const GOOGLE_TTS_MAX_CHUNK_CHARS = 3000;
/** A 60-minute episode is ~18 chunks; this only stops a runaway script. */
export const GOOGLE_TTS_MAX_CHUNKS = 40;

/** Split text at paragraph, then sentence, then word boundaries so no piece exceeds maxChars. */
export function chunkNarration(text: string, maxChars = GOOGLE_TTS_MAX_CHUNK_CHARS): string[] {
  const pieces: string[] = [];
  const pushSplit = (unit: string, splitter: RegExp, next?: (u: string) => void) => {
    for (const part of unit.split(splitter).map((p) => p.trim()).filter(Boolean)) {
      if (part.length <= maxChars) pieces.push(part);
      else if (next) next(part);
      else for (let i = 0; i < part.length; i += maxChars) pieces.push(part.slice(i, i + maxChars));
    }
  };
  const byWords = (u: string) => pushSplit(u, /\s+/);
  const bySentences = (u: string) => pushSplit(u, /(?<=[.!?…])\s+/, byWords);
  pushSplit(text, /\n\s*\n/, bySentences);

  // Greedy repack: join adjacent pieces while they fit, separated by a blank
  // line (a paragraph break reads as a natural beat in TTS).
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const joined = current ? `${current}\n\n${piece}` : piece;
    if (joined.length <= maxChars) current = joined;
    else {
      if (current) chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Pack whole dialogue turns into chunks; a single over-long turn is split into several turns by the same speaker. */
export function chunkDialogue(lines: DialogueLine[], maxChars = GOOGLE_TTS_MAX_CHUNK_CHARS): DialogueLine[][] {
  const size = (l: DialogueLine) => l.speaker.length + 2 + l.text.length + 1;
  const turns = lines.flatMap((l) =>
    size(l) <= maxChars
      ? [l]
      : chunkNarration(l.text, maxChars - l.speaker.length - 3).map((text) => ({ speaker: l.speaker, text })),
  );
  const chunks: DialogueLine[][] = [];
  let current: DialogueLine[] = [];
  let used = 0;
  for (const turn of turns) {
    if (current.length > 0 && used + size(turn) > maxChars) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(turn);
    used += size(turn);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

export type GoogleSpeechMode =
  | { kind: "single"; voice: string }
  | { kind: "dialogue"; speakers: [{ label: string; voice: string }, { label: string; voice: string }] };

export type GoogleTtsChunk = { kind: "narration"; text: string } | { kind: "dialogue"; lines: DialogueLine[] };

/** Short style direction in the documented "Say cheerfully: …" form. */
const NARRATION_DIRECTION = "Read this podcast narration aloud in a warm, natural, engaging host's voice at a steady pace:";

export function buildGoogleTtsRequest(
  modelId: GoogleTtsModelId,
  chunk: GoogleTtsChunk,
  mode: GoogleSpeechMode,
): { url: string; body: Record<string, unknown> } {
  const url = `${GEMINI_API_BASE}/models/${modelId}:generateContent`;
  const prebuilt = (voiceName: string) => ({ prebuiltVoiceConfig: { voiceName } });

  if (chunk.kind === "dialogue" && mode.kind === "dialogue") {
    const [a, b] = mode.speakers;
    const text =
      `TTS the following podcast conversation between ${a.label} and ${b.label}, in a warm, natural, conversational tone:\n` +
      chunk.lines.map((l) => `${l.speaker}: ${l.text}`).join("\n");
    return {
      url,
      body: {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: mode.speakers.map((s) => ({ speaker: s.label, voiceConfig: prebuilt(s.voice) })),
            },
          },
        },
      },
    };
  }

  const text = chunk.kind === "narration" ? chunk.text : chunk.lines.map((l) => l.text).join("\n");
  const voice = mode.kind === "single" ? mode.voice : mode.speakers[0].voice;
  return {
    url,
    body: {
      contents: [{ parts: [{ text: `${NARRATION_DIRECTION}\n\n${text}` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: prebuilt(voice) },
      },
    },
  };
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ "@type"?: string; reason?: string; retryDelay?: string }>;
  };
}

interface GenerateContentBody extends GoogleErrorBody {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> };
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export type ParsedTtsResponse =
  | { ok: true; pcm: Buffer; sampleRate: number; inputTokens: number; outputTokens: number }
  | { ok: false; error: string; retryable: boolean };

/** Pull the PCM out of a 200 response. A 200 with no audio (Google notes TTS occasionally returns text tokens) is retryable. */
export function parseGoogleTtsResponse(json: GenerateContentBody): ParsedTtsResponse {
  if (json.promptFeedback?.blockReason) {
    return { ok: false, error: `Google declined to voice this section (${json.promptFeedback.blockReason}).`, retryable: false };
  }
  const candidate = json.candidates?.[0];
  const part = candidate?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) {
    const why = candidate?.finishReason ? ` (finish reason ${candidate.finishReason})` : "";
    return { ok: false, error: `Google returned no audio for this section${why}.`, retryable: true };
  }
  const mimeType = (part.inlineData.mimeType ?? "").toLowerCase();
  if (mimeType && !/audio\/(l16|pcm)/.test(mimeType)) {
    return { ok: false, error: `Google returned audio in an unexpected format (${mimeType}).`, retryable: false };
  }
  const rate = Number(mimeType.match(/rate=(\d+)/)?.[1] ?? 24000);
  return {
    ok: true,
    pcm: Buffer.from(part.inlineData.data, "base64"),
    sampleRate: Number.isFinite(rate) && rate > 0 ? rate : 24000,
    inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

/**
 * A sentence a customer can act on for a non-2xx Gemini API response. Never
 * includes the key: it travels in a header, and Google's error bodies don't
 * echo it.
 */
export function describeGoogleError(status: number, body: GoogleErrorBody | null): { reason: string; retryable: boolean } {
  const err = body?.error;
  const reasons = new Set((err?.details ?? []).map((d) => d.reason).filter(Boolean));
  const message = (err?.message ?? "").slice(0, 200);

  if (reasons.has("API_KEY_INVALID") || /api key not valid|api key expired/i.test(message) || status === 401) {
    return { reason: "Google rejected that API key — check it was copied whole from Google AI Studio and hasn't been deleted or expired.", retryable: false };
  }
  if (reasons.has("SERVICE_DISABLED") || /has not been used in project|is disabled/i.test(message)) {
    return { reason: "The Gemini API (Generative Language API) isn't enabled on this key's Google Cloud project — enable it, wait a minute, and try again.", retryable: false };
  }
  if (reasons.has("API_KEY_SERVICE_BLOCKED")) {
    return { reason: "This key is restricted to other Google APIs — edit its API restrictions to allow the Gemini API (Generative Language API).", retryable: false };
  }
  if (reasons.has("API_KEY_HTTP_REFERRER_BLOCKED") || reasons.has("API_KEY_IP_ADDRESS_BLOCKED") || reasons.has("API_KEY_ANDROID_APP_BLOCKED") || reasons.has("API_KEY_IOS_APP_BLOCKED")) {
    return { reason: "This key has an application restriction (websites, IP addresses or apps) that blocks calls from our servers — set Application restrictions to None and keep the API restriction instead.", retryable: false };
  }
  if (status === 403) {
    return { reason: `Google refused this key (403${message ? `: ${message}` : ""}).`, retryable: false };
  }
  if (status === 404) {
    return { reason: "Google says the Gemini text-to-speech model isn't available to this key. Check the key's project can use the Gemini API in your region.", retryable: false };
  }
  if (status === 429) {
    return { reason: "Google says this key is over its rate limit or quota. Free-tier limits are low — add billing to the key's project in Google AI Studio, or try again in a minute.", retryable: true };
  }
  if (status === 400) {
    return { reason: `Google rejected the request (400${message ? `: ${message}` : ""}).`, retryable: false };
  }
  return { reason: `Google returned ${status}${message ? `: ${message}` : ""}.`, retryable: status >= 500 };
}

/** "37s" / "1.5s" retryDelay from a 429's RetryInfo detail, in ms. */
function retryDelayMs(body: GoogleErrorBody | null): number | null {
  const delay = body?.error?.details?.find((d) => d.retryDelay)?.retryDelay;
  const seconds = delay ? Number(delay.replace(/s$/, "")) : NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

// ---------------------------------------------------------------------------
// PCM
// ---------------------------------------------------------------------------

/** Concatenate 16-bit mono PCM chunks with a short silence between them. Odd trailing bytes are dropped. */
export function concatPcm(chunks: Buffer[], sampleRate: number, gapMs = 250): Int16Array {
  const gap = Math.round((sampleRate * gapMs) / 1000);
  const samples = chunks.map((c) => Math.floor(c.length / 2));
  const total = samples.reduce((a, b) => a + b, 0) + gap * Math.max(0, chunks.length - 1);
  const out = new Int16Array(total);
  let offset = 0;
  chunks.forEach((chunk, i) => {
    if (i > 0) offset += gap; // Int16Array is zero-filled: silence
    for (let s = 0; s < samples[i]; s++) out[offset + s] = chunk.readInt16LE(s * 2);
    offset += samples[i];
  });
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GoogleSpeechResult = {
  pcm: Int16Array;
  sampleRate: number;
  chunks: number;
  mode: "single" | "dialogue";
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export function googleTtsCostUsd(modelId: GoogleTtsModelId, inputTokens: number, outputTokens: number): number {
  const price = GOOGLE_TTS_PRICING[modelId];
  return price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : 0;
}

/** Plan the chunks for a script: dialogue turns when a two-voice mode parses, narration otherwise. */
export function planGoogleTtsChunks(
  script: string,
  mode: GoogleSpeechMode,
  maxChars = GOOGLE_TTS_MAX_CHUNK_CHARS,
): { mode: GoogleSpeechMode; chunks: GoogleTtsChunk[] } {
  const clean = cleanScriptForSpeech(script);
  if (mode.kind === "dialogue") {
    const lines = parseDialogue(clean, [mode.speakers[0].label, mode.speakers[1].label]);
    if (lines) {
      return { mode, chunks: chunkDialogue(lines, maxChars).map((l) => ({ kind: "dialogue", lines: l })) };
    }
    // The writer didn't label two speakers — voice it with the host's voice rather than fail.
    const single: GoogleSpeechMode = { kind: "single", voice: mode.speakers[0].voice };
    const unlabelled = clean.replace(new RegExp(`^\\s*(${mode.speakers.map((s) => s.label).join("|")})\\s*:\\s*`, "gim"), "");
    return { mode: single, chunks: chunkNarration(unlabelled, maxChars).map((text) => ({ kind: "narration", text })) };
  }
  return { mode, chunks: chunkNarration(clean, maxChars).map((text) => ({ kind: "narration", text })) };
}

/**
 * Voice a whole script: plan chunks, call Google once per chunk (sequentially —
 * free-tier limits are a few requests a minute), retry 429/5xx/no-audio with
 * backoff, and return the concatenated PCM.
 */
export async function synthesizeGoogleSpeech(opts: {
  apiKey: string;
  modelId: GoogleTtsModelId;
  script: string;
  mode: GoogleSpeechMode;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxChunkChars?: number;
  maxAttempts?: number;
  timeoutMs?: number;
}): Promise<GoogleSpeechResult> {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 3;

  const plan = planGoogleTtsChunks(opts.script, opts.mode, opts.maxChunkChars);
  if (plan.chunks.length === 0) throw new Error("The script came back empty, so there was nothing to voice.");
  if (plan.chunks.length > GOOGLE_TTS_MAX_CHUNKS) {
    throw new Error(`The script is too long to voice in one run (${plan.chunks.length} sections; the limit is ${GOOGLE_TTS_MAX_CHUNKS}).`);
  }

  const pcmChunks: Buffer[] = [];
  let sampleRate = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (let i = 0; i < plan.chunks.length; i++) {
    const { url, body } = buildGoogleTtsRequest(opts.modelId, plan.chunks[i], plan.mode);
    let lastError = "";
    let done = false;

    for (let attempt = 1; attempt <= maxAttempts && !done; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "x-goog-api-key": opts.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
        });
      } catch (err) {
        lastError = (err as { name?: string } | null)?.name === "TimeoutError"
          ? "Google didn't respond in time."
          : `Couldn't reach Google: ${err instanceof Error ? err.message : String(err)}`;
        if (attempt < maxAttempts) await sleep(2000 * 2 ** (attempt - 1));
        continue;
      }

      const json = (await res.json().catch(() => null)) as GenerateContentBody | null;
      if (!res.ok) {
        const { reason, retryable } = describeGoogleError(res.status, json);
        lastError = reason;
        if (!retryable) throw new Error(`Google TTS section ${i + 1}/${plan.chunks.length}: ${reason}`);
        if (attempt < maxAttempts) await sleep(Math.min(60_000, retryDelayMs(json) ?? 2000 * 2 ** (attempt - 1)));
        continue;
      }

      const parsed = parseGoogleTtsResponse(json ?? {});
      if (!parsed.ok) {
        lastError = parsed.error;
        if (!parsed.retryable) throw new Error(`Google TTS section ${i + 1}/${plan.chunks.length}: ${parsed.error}`);
        if (attempt < maxAttempts) await sleep(2000 * 2 ** (attempt - 1));
        continue;
      }
      if (sampleRate && parsed.sampleRate !== sampleRate) {
        throw new Error(`Google TTS returned mixed sample rates (${sampleRate} and ${parsed.sampleRate} Hz).`);
      }
      sampleRate = parsed.sampleRate;
      pcmChunks.push(parsed.pcm);
      inputTokens += parsed.inputTokens;
      outputTokens += parsed.outputTokens;
      done = true;
    }

    if (!done) throw new Error(`Google TTS section ${i + 1}/${plan.chunks.length} failed after ${maxAttempts} attempts: ${lastError}`);
  }

  return {
    pcm: concatPcm(pcmChunks, sampleRate),
    sampleRate,
    chunks: plan.chunks.length,
    mode: plan.mode.kind,
    inputTokens,
    outputTokens,
    costUsd: googleTtsCostUsd(opts.modelId, inputTokens, outputTokens),
  };
}

/**
 * Connect-time check: one free, read-only models.get for the default TTS
 * model. Proves the key is valid, the Gemini API is enabled and allowed by the
 * key's restrictions, and the TTS model is visible to it — without generating
 * any audio.
 */
export async function verifyGoogleTtsKey(
  apiKey: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await fetchImpl(`${GEMINI_API_BASE}/models/${GOOGLE_TTS_DEFAULT_MODEL}`, {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as GoogleErrorBody | null;
    return { ok: false, reason: describeGoogleError(res.status, body).reason };
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "TimeoutError") {
      return { ok: false, reason: "Google didn't respond in time. Try again." };
    }
    return { ok: false, reason: `Couldn't reach Google: ${err instanceof Error ? err.message : String(err)}` };
  }
}
