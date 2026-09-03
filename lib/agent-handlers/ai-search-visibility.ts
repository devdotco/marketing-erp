import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const aiSearchVisibilityHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const testQueries = String(config.testQueries ?? "");
  const competitors = String(config.competitors ?? "");
  const generateLlmsTxt = config.generateLlmsTxt !== false;
  const reportFormat = String(config.reportFormat ?? "Dashboard");
  const siteUrl = String(config.siteUrl ?? "");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.uniqueValueProp ? `Unique value: ${businessProfile.uniqueValueProp}` : "",
        businessProfile.websiteUrl ? `Website: ${siteUrl || businessProfile.websiteUrl}` : "",
        businessProfile.competitors.length > 0
          ? `Known competitors: ${competitors || businessProfile.competitors.join(", ")}`
          : competitors
            ? `Competitors to track: ${competitors}`
            : "",
      ].filter(Boolean).join("\n")
    : "";

  const resolvedSiteUrl = siteUrl || businessProfile?.websiteUrl || "";

  const systemPrompt = [
    "You are an AI search visibility specialist.",
    "Citation in LLM responses depends on: topical authority, schema markup, brand mention frequency, and content that directly answers user questions.",
    "Focus recommendations on these levers — not vanity metrics.",
    "Be specific about which content gaps or authority gaps explain low citation probability.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const queries = testQueries
    .split(/[\n,]+/)
    .map((q) => q.trim())
    .filter(Boolean);

  const competitorList = competitors
    .split(/[\n,]+/)
    .map((c) => c.trim())
    .filter(Boolean);

  const userPrompt = [
    `Analyse AI search visibility for: ${resolvedSiteUrl || "the client website"}`,
    "",
    `Test queries (${queries.length}):`,
    queries.map((q, i) => `${i + 1}. ${q}`).join("\n"),
    "",
    competitorList.length > 0
      ? `Competing domains to track in AI citations: ${competitorList.join(", ")}`
      : "",
    "",
    "For each query, simulate how each major AI engine would likely respond:",
    "- Would the client's site be cited?",
    "- If yes, at what position?",
    "- Which competitors would more likely be cited, and why?",
    "- What specific changes would increase citation probability?",
    "",
    "Scoring: citationSharePct = percentage of AI engines that would cite the client for this query (0-100)",
    "overallCitationShare = average across all queries",
    "",
    generateLlmsTxt
      ? `Generate an llms.txt file for ${resolvedSiteUrl || "the client site"} following the llms.txt spec (machine-readable site summary for AI crawlers).`
      : "Set llmsTxt to null.",
    "",
    `Report format requested: ${reportFormat}`,
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      siteUrl: resolvedSiteUrl,
      testDate: new Date().toISOString().split("T")[0],
      queryResults: [
        {
          query: "example test query",
          aiEngines: [
            {
              engine: "ChatGPT",
              wasCited: false,
              citationPosition: null,
              competitorsCited: ["competitor.com"],
              responseExcerpt:
                "Summary of how this AI engine would answer the query and who it would cite...",
            },
            {
              engine: "Perplexity",
              wasCited: true,
              citationPosition: 2,
              competitorsCited: ["competitor.com"],
              responseExcerpt: "Summary of Perplexity's likely response...",
            },
            {
              engine: "Gemini",
              wasCited: false,
              citationPosition: null,
              competitorsCited: ["competitor.com"],
              responseExcerpt: "Summary of Gemini's likely response...",
            },
            {
              engine: "Claude",
              wasCited: false,
              citationPosition: null,
              competitorsCited: ["competitor.com"],
              responseExcerpt: "Summary of Claude's likely response...",
            },
          ],
          citationSharePct: 25,
          recommendation:
            "Specific action to improve citation probability for this query...",
        },
      ],
      overallCitationShare: 25,
      llmsTxt: generateLlmsTxt
        ? `# ${businessProfile?.businessName ?? "Site Name"}\n\n> One-line site description\n\n## About\n...\n\n## Key Pages\n...\n\n## Products/Services\n...`
        : null,
      improvementOpportunities: [
        {
          area: "Topical Authority | Schema Markup | Brand Mentions | Content Gaps",
          action: "Specific action to take...",
          expectedImpact: "Expected improvement in citation probability...",
        },
      ],
      simulationNote:
        "These are AI-simulated citation predictions. Real citation testing requires querying each AI engine directly.",
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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { report: rawText };
  } catch {
    output = { report: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  // Haiku 4.5 pricing: $0.80/M input, $4/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
