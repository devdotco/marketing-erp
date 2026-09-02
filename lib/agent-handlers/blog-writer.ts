import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export const blogWriterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const wordCount = Number(config.wordCount ?? 1200);
  const tone = String(config.tone ?? "professional and helpful");
  const targetKeyword = String(config.targetKeyword ?? "");

  const businessProfile = run.agentConfig.workspaceId; // would normally fetch from DB

  const prompt = [
    `Write a ${wordCount}-word SEO-optimized blog post.`,
    targetKeyword ? `Target keyword: "${targetKeyword}"` : "",
    `Tone: ${tone}`,
    "Structure: compelling H1, intro paragraph, 3-5 H2 sections with body, conclusion with CTA.",
    "Return JSON: { title, slug, metaDescription, content (HTML), wordCount }",
  ].filter(Boolean).join("\n");

  const startTime = Date.now();

  const message = await client.messages.create({
    model: "claude-sonnet-5-20251015",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";

  // Extract JSON from response
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { content: rawText };
  } catch {
    output = { content: rawText };
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000; // claude-sonnet pricing

  return { output, costUsd };
};
