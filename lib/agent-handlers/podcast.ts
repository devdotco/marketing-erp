import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export const podcastHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const episodeLength = Number(config.episodeLength ?? 15);
  const voiceId = String(config.voiceId ?? "sonic");

  // Generate episode script
  const scriptPrompt = `Write a ${episodeLength}-minute podcast episode script.
Style: conversational solo host, engaging opening hook, 3 main topics with transitions, call-to-action close.
Return JSON: { title, description, script, estimatedMinutes }`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [{ role: "user", content: scriptPrompt }],
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
  output.note = "Audio synthesis via Cartesia TTS pending — script ready for review.";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000; // haiku pricing

  return { output, costUsd };
};
