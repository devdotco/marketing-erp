import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { lines, num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import {
  dialogueSpeakers,
  googleTtsModelId,
  googleVoiceName,
  GOOGLE_DEFAULT_SECOND_VOICE,
  GOOGLE_DEFAULT_VOICE,
  synthesizeGoogleSpeech,
  type GoogleSpeechMode,
} from "@/lib/voice/google-tts";
import { encodeMp3 } from "@/lib/voice/mp3";
import { scriptForSpeech, selectVoiceProvider, voiceProviderChoice, VOICE_PROVIDER_NAMES } from "@/lib/voice/provider";

export const podcastHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);
  // Renamed to the Run form's keys on 2026-09-14; the old names still work from a saved config.
  applyRenamedInputs(run, config, { episodeLengthMinutes: "episodeLength", targetAudience: "audienceLevel" });
  const episodeLength = num(config, "episodeLengthMinutes", 10, { min: 1, max: 60 });
  const episodeTopic = String(config.episodeTopic ?? "");
  const targetAudience = str(config, "targetAudience");
  const hostStyle = str(config, "hostStyle", "Solo host");
  const brandKeywords = lines(config, "brandKeywords", 30);
  const additionalContext = str(config, "additionalContext");
  // A Cartesia *voice* ID (a UUID from the customer's Cartesia dashboard) —
  // the field was once labelled "Cartesia Voice Model ID" and defaulted to
  // "sonic-2", which was neither a valid voice ID nor a current model ID.
  // Falls back to Cartesia's public demo voice so an unconfigured run still
  // produces audio. Ignored when the run voices with Google.
  const DEMO_VOICE_ID = "a0e99841-438c-4a64-b679-ae501e7d6091";
  const voiceId = String(config.voiceId ?? "") || DEMO_VOICE_ID;
  const showName = str(config, "showName");
  const voiceProviderInput = str(config, "voiceProvider");
  const googleVoice = googleVoiceName(str(config, "googleVoice"), GOOGLE_DEFAULT_VOICE);
  const googleSecondVoice = googleVoiceName(str(config, "googleSecondVoice"), GOOGLE_DEFAULT_SECOND_VOICE);
  const googleModel = googleTtsModelId(str(config, "googleTtsModel"));

  // Which voice provider this run uses — decided before the script is written,
  // because a two-voice Google episode needs the writer to label each turn.
  const { workspaceId } = run.agentConfig;
  const [cartesiaIntegration, googleTtsIntegration] = await Promise.all([
    prisma.integration.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "CARTESIA" } } }),
    prisma.integration.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "GOOGLE_TTS" } } }),
  ]);
  const voiceSelection = selectVoiceProvider(voiceProviderChoice(voiceProviderInput), {
    cartesia: Boolean(cartesiaIntegration?.encryptedCredentials),
    google: Boolean(googleTtsIntegration?.encryptedCredentials),
  });
  const speakerLabels = voiceSelection.provider === "google" ? dialogueSpeakers(hostStyle) : null;

  // Fetch business profile for show context
  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const showContext = showName || businessProfile?.businessName
    ? `Podcast / show name: ${showName || businessProfile?.businessName}`
    : "";
  const industryContext = businessProfile?.industry
    ? `Industry: ${businessProfile.industry}`
    : "";

  const systemPrompt = [
    "You are an expert podcast script writer.",
    "You write engaging, conversational scripts that sound natural when read aloud.",
    "Scripts use short sentences, natural pauses (marked with [PAUSE]), and clear verbal transitions.",
    "Always open with a hook in the first 30 seconds. Never start with 'Welcome to...' as the very first words.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    showContext,
    industryContext,
  ].filter(Boolean).join("\n");

  const userPrompt = [
    `Write a ${episodeLength}-minute podcast episode script.`,
    episodeTopic ? `Topic: ${episodeTopic}` : "Choose a relevant topic for the industry.",
    targetAudience ? `Target audience: ${targetAudience} — calibrate tone, vocabulary depth and examples to them.` : "",
    `Format: ${hostStyle}`,
    brandKeywords.length > 0
      ? `Brand keywords to weave naturally into the script and show notes (never force one in): ${brandKeywords.join(", ")}`
      : "",
    additionalContext
      ? `Additional context to incorporate (guest details, sponsor reads, proprietary data — use it as given, do not embellish):\n${additionalContext}`
      : "",
    "",
    "Script structure:",
    "1. Cold open hook (30-60 sec) — a surprising fact, bold claim, or short story",
    "2. Brief intro / episode preview (30 sec)",
    "3. Main content: 3 segments with clear transitions",
    "4. Recap (60 sec)",
    "5. Call-to-action close (30 sec)",
    "",
    "Mark speaker cues, pauses, and emphasis: [PAUSE], [EMPHASIS], [TRANSITION]",
    speakerLabels
      ? `This episode is voiced by two different voices. In fullScript, put every spoken turn on its own line starting with exactly "${speakerLabels[0]}:" or "${speakerLabels[1]}:" — no other speaker names before the colon, and no stage directions outside a turn.`
      : "",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      episodeTitle: "Podcast episode title",
      episodeDescription: "2-3 sentence show notes description for Transistor/podcast directories",
      estimatedMinutes: episodeLength,
      hostStyle,
      segments: [
        { name: "Cold Open", durationMinutes: 1, script: "Full word-for-word script..." },
        { name: "Segment 1: ...", durationMinutes: 5, script: "..." },
        { name: "Segment 2: ...", durationMinutes: 5, script: "..." },
        { name: "Segment 3: ...", durationMinutes: 5, script: "..." },
        { name: "Close & CTA", durationMinutes: 1, script: "..." },
      ],
      fullScript: "Complete concatenated script for TTS...",
      showNotes: "Markdown show notes with timestamps...",
      tags: ["tag1", "tag2"],
    }),
  ].filter(Boolean).join("\n");

  const message = await client.messages.create({
    model: MODELS.fast,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { script: rawText };
  } catch {
    output = { script: rawText };
  }

  output.generatedAt = new Date().toISOString();
  // Priced from lib/ai/models.ts — Haiku 4.5 is $1/M input, $5/M output.
  let costUsd = estimateCostUsd(MODELS.fast, message.usage);

  // --- Live TTS: Cartesia or Google (Gemini TTS), whichever this run selected ---
  let ttsLive = false;
  let audioBytesFull: Buffer | null = null;
  if (voiceSelection.provider) output.ttsProvider = voiceSelection.provider;
  try {
    if (voiceSelection.provider === "cartesia" && cartesiaIntegration?.encryptedCredentials) {
      // Cartesia-Version is a snapshot date, not a semver — 2024-06-10 was nearly
      // 2.5 years stale, and "sonic-english"/"sonic-2" are not current model ids
      // (current family is sonic-3.x). https://docs.cartesia.ai/api-reference/tts/bytes
      output.voiceId = voiceId;
      const creds = await decryptCredentials<{ apiKey: string }>(
        cartesiaIntegration.encryptedCredentials
      );

      const fullScript = scriptForSpeech(output);
      if (!fullScript) throw new Error("The script came back empty, so there was nothing to voice.");
      const ttsRes = await fetch("https://api.cartesia.ai/tts/bytes", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.apiKey}`,
          "Cartesia-Version": "2025-04-16",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model_id: "sonic-3",
          transcript: fullScript,
          voice: { mode: "id", id: voiceId },
          output_format: { container: "mp3", encoding: "mp3", sample_rate: 44100 },
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!ttsRes.ok) {
        throw new Error(`Cartesia TTS error ${ttsRes.status}: ${(await ttsRes.text()).slice(0, 300)}`);
      }

      audioBytesFull = Buffer.from(await ttsRes.arrayBuffer());
    } else if (voiceSelection.provider === "google" && googleTtsIntegration?.encryptedCredentials) {
      // Gemini API TTS — see lib/voice/google-tts.ts for the contract, limits and
      // why this Google product. Returns PCM; encoded to MP3 once, here.
      const creds = await decryptCredentials<{ apiKey: string }>(
        googleTtsIntegration.encryptedCredentials
      );
      const mode: GoogleSpeechMode = speakerLabels
        ? { kind: "dialogue", speakers: [{ label: speakerLabels[0], voice: googleVoice }, { label: speakerLabels[1], voice: googleSecondVoice }] }
        : { kind: "single", voice: googleVoice };

      const speech = await synthesizeGoogleSpeech({
        apiKey: creds.apiKey,
        modelId: googleModel,
        script: scriptForSpeech(output),
        mode,
      });
      audioBytesFull = await encodeMp3(speech.pcm, speech.sampleRate);

      output.googleTtsModel = googleModel;
      output.googleVoices = speech.mode === "dialogue"
        ? { [speakerLabels![0]]: googleVoice, [speakerLabels![1]]: googleSecondVoice }
        : { narrator: googleVoice };
      output.ttsMode = speech.mode;
      if (speakerLabels && speech.mode === "single") {
        output.ttsModeNote = "The script didn't label two speakers, so it was voiced with the host voice only.";
      }
      output.ttsSections = speech.chunks;
      output.audioDurationSeconds = Math.round(speech.pcm.length / speech.sampleRate);
      output.ttsCostUsd = speech.costUsd;
      costUsd += speech.costUsd;
    }

    if (audioBytesFull) {
      const maxBytes = 100 * 1024; // 100 KB cap on run output
      output.audioBase64 = audioBytesFull.subarray(0, maxBytes).toString("base64");
      output.audioSizeBytes = audioBytesFull.length;
      output.audioTruncated = audioBytesFull.length > maxBytes;
      output.ttsStatus = "complete";
      output.source = "live";
      ttsLive = true;
    }
  } catch (err) {
    output.ttsError = err instanceof Error ? err.message : String(err);
  }

  // --- Live Transistor Episode ---
  // If a voice provider produced audio above, upload it via authorize_upload → PUT →
  // create episode with the resulting audio_url, instead of leaving a bare
  // draft the customer has to attach audio to by hand.
  // https://developers.transistor.fm/#tag/episodes
  let transistorLive = false;
  let transistorConnected = false;
  try {
    const transistorIntegration = await prisma.integration.findUnique({
      where: {
        workspaceId_provider: {
          workspaceId: run.agentConfig.workspaceId,
          provider: "TRANSISTOR",
        },
      },
    });

    if (transistorIntegration?.encryptedCredentials) {
      transistorConnected = true;
      const creds = await decryptCredentials<{ apiKey: string }>(
        transistorIntegration.encryptedCredentials
      );
      const authHeaders = { "x-api-key": creds.apiKey };

      // Use configured show_id or fall back to first show on the account
      let resolvedShowId = String(config.transistorShowId ?? "");

      if (!resolvedShowId) {
        const showsRes = await fetch("https://api.transistor.fm/v1/shows", {
          headers: authHeaders,
          signal: AbortSignal.timeout(10_000),
        });
        if (!showsRes.ok) throw new Error(`Transistor shows ${showsRes.status}: ${(await showsRes.text()).slice(0, 300)}`);
        const showsData = await showsRes.json() as { data?: Array<{ id: string }> };
        resolvedShowId = showsData.data?.[0]?.id ?? "";
        if (!resolvedShowId) throw new Error("This Transistor account has no shows to publish to.");
      }

      let audioUrl: string | undefined;
      if (audioBytesFull) {
        const slug = String(output.episodeTitle ?? "episode")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "episode";
        const filename = `${slug}.mp3`;
        const authRes = await fetch(
          `https://api.transistor.fm/v1/episodes/authorize_upload?filename=${encodeURIComponent(filename)}`,
          { headers: authHeaders, signal: AbortSignal.timeout(10_000) },
        );
        if (!authRes.ok) throw new Error(`Transistor authorize_upload ${authRes.status}: ${(await authRes.text()).slice(0, 300)}`);
        const authData = await authRes.json() as {
          data?: { attributes?: { upload_url?: string; content_type?: string; audio_url?: string } };
        };
        const { upload_url, content_type, audio_url } = authData.data?.attributes ?? {};
        if (upload_url && audio_url) {
          const putRes = await fetch(upload_url, {
            method: "PUT",
            headers: { "Content-Type": content_type ?? "audio/mpeg" },
            body: new Uint8Array(audioBytesFull),
            // A long episode is several MB; 30s was tight for the upload.
            signal: AbortSignal.timeout(120_000),
          });
          if (!putRes.ok) throw new Error(`Transistor audio upload ${putRes.status}: ${(await putRes.text()).slice(0, 300)}`);
          audioUrl = audio_url;
        }
      }

      const episodeRes = await fetch("https://api.transistor.fm/v1/episodes", {
        method: "POST",
        headers: {
          "x-api-key": creds.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          episode: {
            show_id: resolvedShowId,
            title: String(output.episodeTitle ?? "New Episode"),
            summary: String(output.episodeDescription ?? ""),
            description: String(output.showNotes ?? ""),
            ...(audioUrl ? { audio_url: audioUrl } : {}),
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!episodeRes.ok) {
        throw new Error(`Transistor episode ${episodeRes.status}: ${(await episodeRes.text()).slice(0, 300)}`);
      }

      const episodeData = await episodeRes.json() as {
        data?: { id: string; attributes?: { share_url?: string } };
      };
      output.transistorEpisodeId = episodeData.data?.id;
      output.transistorShareUrl = episodeData.data?.attributes?.share_url;
      // Episodes are always created as drafts regardless of what's posted.
      output.transistorStatus = "draft";
      output.transistorAudioAttached = Boolean(audioUrl);
      output.source = "live";
      transistorLive = true;
    }
  } catch (err) {
    output.transistorError = err instanceof Error ? err.message : String(err);
  }

  // --- Status/notes, distinguishing "not connected" from "connected but failed" ---
  if (!voiceSelection.provider) {
    output.ttsStatus = "pending";
    output.ttsNote = voiceSelection.note;
  } else if (!ttsLive) {
    output.ttsStatus = "failed";
    output.ttsNote = `${VOICE_PROVIDER_NAMES[voiceSelection.provider]} is connected but the TTS call failed — see ttsError. The script above is still real; only audio generation didn't run.`;
  }
  if (!transistorConnected) {
    output.transistorStatus = "pending";
    output.transistorNote = "Connect Transistor in Settings → Integrations to create a draft episode.";
  } else if (!transistorLive) {
    output.transistorStatus = "failed";
    output.transistorNote = "Transistor is connected but episode creation failed — see transistorError.";
  }
  if (!voiceSelection.provider && !transistorConnected) output.source = "simulation";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
