import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

export const podcastHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const episodeLength = Number(config.episodeLength ?? 15);
  const episodeTopic = String(config.episodeTopic ?? "");
  const audienceLevel = String(config.audienceLevel ?? "intermediate");
  const hostStyle = String(config.hostStyle ?? "Solo host");
  const voiceId = String(config.voiceId ?? "sonic-2");
  const showName = String(config.showName ?? "");

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
    `Audience knowledge level: ${audienceLevel}`,
    `Format: ${hostStyle}`,
    "",
    "Script structure:",
    "1. Cold open hook (30-60 sec) — a surprising fact, bold claim, or short story",
    "2. Brief intro / episode preview (30 sec)",
    "3. Main content: 3 segments with clear transitions",
    "4. Recap (60 sec)",
    "5. Call-to-action close (30 sec)",
    "",
    "Mark speaker cues, pauses, and emphasis: [PAUSE], [EMPHASIS], [TRANSITION]",
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
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { script: rawText };
  } catch {
    output = { script: rawText };
  }

  output.voiceId = voiceId;
  output.generatedAt = new Date().toISOString();

  // Haiku 4.5 pricing: $0.80/M input, $4/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  // --- Live Cartesia TTS ---
  let cartesiaLive = false;
  try {
    const cartesiaIntegration = await prisma.integration.findUnique({
      where: {
        workspaceId_provider: {
          workspaceId: run.agentConfig.workspaceId,
          provider: "CARTESIA",
        },
      },
    });

    if (cartesiaIntegration?.encryptedCredentials) {
      const creds = await decryptCredentials<{ apiKey: string }>(
        cartesiaIntegration.encryptedCredentials
      );

      const fullScript = String(output.fullScript ?? "");
      const ttsRes = await fetch("https://api.cartesia.ai/tts/bytes", {
        method: "POST",
        headers: {
          "X-API-Key": creds.apiKey,
          "Cartesia-Version": "2024-06-10",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model_id: "sonic-english",
          transcript: fullScript,
          voice: { mode: "id", id: "a0e99841-438c-4a64-b679-ae501e7d6091" },
          output_format: { container: "mp3", encoding: "mp3", sample_rate: 44100 },
        }),
      });

      if (!ttsRes.ok) {
        throw new Error(`Cartesia TTS error ${ttsRes.status}: ${await ttsRes.text()}`);
      }

      const audioBuffer = await ttsRes.arrayBuffer();
      const audioBytes = Buffer.from(audioBuffer);
      const maxBytes = 100 * 1024; // 100 KB cap on run output
      output.audioBase64 = audioBytes.slice(0, maxBytes).toString("base64");
      output.audioSizeBytes = audioBytes.length;
      output.audioTruncated = audioBytes.length > maxBytes;
      output.ttsStatus = "complete";
      output.source = "live";
      cartesiaLive = true;
    }
  } catch (err) {
    output.ttsError = err instanceof Error ? err.message : String(err);
  }

  // --- Live Transistor Episode ---
  let transistorLive = false;
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
      const creds = await decryptCredentials<{ apiKey: string }>(
        transistorIntegration.encryptedCredentials
      );

      // Use configured show_id or fall back to first show on the account
      let resolvedShowId = String(config.transistorShowId ?? "");

      if (!resolvedShowId) {
        const showsRes = await fetch("https://api.transistor.fm/v1/shows", {
          headers: { "x-api-key": creds.apiKey },
        });
        if (showsRes.ok) {
          const showsData = await showsRes.json() as { data?: Array<{ id: string }> };
          resolvedShowId = showsData.data?.[0]?.id ?? "";
        }
      }

      if (resolvedShowId) {
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
              status: "draft",
            },
          }),
        });

        if (!episodeRes.ok) {
          throw new Error(`Transistor episode error ${episodeRes.status}: ${await episodeRes.text()}`);
        }

        const episodeData = await episodeRes.json() as {
          data?: { id: string; attributes?: { share_url?: string; upload_url?: string } };
        };
        output.transistorEpisodeId = episodeData.data?.id;
        output.transistorShareUrl = episodeData.data?.attributes?.share_url;
        output.transistorUploadUrl = episodeData.data?.attributes?.upload_url;
        output.transistorStatus = "draft";
        output.source = "live";
        transistorLive = true;
      }
    }
  } catch (err) {
    output.transistorError = err instanceof Error ? err.message : String(err);
  }

  // --- Simulation fallback when neither live integration ran ---
  if (!cartesiaLive && !transistorLive) {
    output.ttsStatus = "pending";
    output.ttsNote =
      "Script approved — submit to Cartesia TTS to generate audio. Audio will be uploaded to Transistor for review before publishing.";
    output.source = "simulation";
  } else if (!cartesiaLive) {
    output.ttsStatus = "pending";
    output.ttsNote =
      "Script ready — no Cartesia integration found. Connect Cartesia to generate audio.";
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
