import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export const technicalAuditHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const crawlDepth = Number(config.crawlDepth ?? 3);
  const gscProperty = String(config.gscProperty ?? "");

  // In production: crawl the site, fetch GSC data, analyze
  // For now: generate a structured audit report
  const prompt = `Generate a technical SEO audit report template.
Crawl depth: ${crawlDepth}
GSC property: ${gscProperty || "not connected"}
Return JSON: {
  summary: string,
  criticalIssues: [{title, description, priority, affectedUrls}],
  warnings: [{title, description, recommendation}],
  passed: [string],
  crawledPages: number,
  score: number
}`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { report: rawText };
  } catch {
    output = { report: rawText };
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};
