import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const operatorHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const weeklyBudgetUsd = Number(config.weeklyBudgetUsd ?? 500);
  const priorityChannels = String(config.priorityChannels ?? "All");
  const autoApproveThreshold = Number(config.autoApproveThreshold ?? 50);
  const reportingDay = String(config.reportingDay ?? "Monday");
  const goalsContext = String(config.goalsContext ?? "");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const businessContext = businessProfile
    ? [
        businessProfile.businessName
          ? `Business: ${businessProfile.businessName}`
          : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.websiteUrl
          ? `Website: ${businessProfile.websiteUrl}`
          : "",
        businessProfile.targetAudience
          ? `Target audience: ${businessProfile.targetAudience}`
          : "",
        businessProfile.uniqueValueProp
          ? `UVP: ${businessProfile.uniqueValueProp}`
          : "",
        businessProfile.goals
          ? `Primary goals: ${JSON.stringify(businessProfile.goals)}`
          : "",
        businessProfile.competitors.length > 0
          ? `Competitors: ${businessProfile.competitors.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const channelFocus =
    priorityChannels === "Content+SEO"
      ? "Focus exclusively on content creation and SEO agents (blog-writer, keyword-research, technical-audit, on-site-publisher, rank-tracker, topic-planner, internal-linking, schema)."
      : priorityChannels === "Paid+Social"
        ? "Focus exclusively on paid advertising and social media agents (google-ads, meta-ads, linkedin-ads, linkedin-poster, x-poster, captions-clips)."
        : priorityChannels === "SEO only"
          ? "Focus exclusively on SEO agents (keyword-research, technical-audit, rank-tracker, topic-planner, internal-linking, schema, content-refresh, gsc-analyst)."
          : "Include agents across all channels: content, SEO, paid, social, email, outreach, and analytics.";

  const today = new Date();
  const weekOfDate = today.toISOString().split("T")[0];

  const systemPrompt = `You are a chief marketing officer and automation strategist.
Propose the weekly agent plan based on goals, last week's results, and available budget.
${channelFocus}
Prioritise ruthlessly — not everything needs to run every week.
Be specific about WHY each agent is scheduled this week, not just what it does.
Auto-approve agents that cost under $${autoApproveThreshold} and are low-risk recurring tasks.
Return ONLY valid JSON — no markdown fences, no preamble.`;

  const userPrompt = `Generate the weekly marketing agent plan for the week of ${weekOfDate}.

Business context:
${businessContext || "No business profile configured."}

Goals and context provided by operator:
${goalsContext || "No specific goals context provided. Use business profile goals."}

Operator configuration:
- Weekly budget: $${weeklyBudgetUsd}
- Priority channels: ${priorityChannels}
- Auto-approve threshold: $${autoApproveThreshold} per run
- Reporting day: ${reportingDay}

Available agents to schedule (pick the most impactful for this week):
blog-writer, keyword-research, technical-audit, weekly-report, competitor-watch, email-marketing,
linkedin-poster, x-poster, on-site-publisher, rank-tracker, topic-planner, internal-linking, schema,
content-refresh, gsc-analyst, meta-ads, google-ads, linkedin-ads, captions-clips, repurposer,
newsletter, video-script, podcast, prospector, outreach, lead-enrichment, review-engine,
landing-page-copy, anomaly-watch, attribution

Estimated cost per agent run: blog-writer $0.08, keyword-research $0.04, technical-audit $0.06,
weekly-report $0.12, competitor-watch $0.03, email-marketing $0.07, linkedin-poster $0.05,
x-poster $0.02, on-site-publisher $0.05, rank-tracker $0.03, topic-planner $0.04,
meta-ads $0.06, google-ads $0.06, captions-clips $0.04, repurposer $0.05,
newsletter $0.08, prospector $0.05, outreach $0.06, lead-enrichment $0.04,
anomaly-watch $0.02, attribution $0.03

Return this exact JSON structure:
${JSON.stringify({
  weekOf: weekOfDate,
  lastWeekSummary: {
    runsCompleted: 0,
    topWin: "string",
    topIssue: "string",
    costSpent: 0,
  },
  proposedPlan: [
    {
      agentSlug: "string",
      agentName: "string",
      rationale: "string",
      estimatedCostUsd: 0,
      inputs: {} as Record<string, unknown>,
      scheduledFor: "string",
      priority: "must run" as const,
      autoApprove: false,
    },
  ],
  totalEstimatedCost: 0,
  channelAllocation: [
    {
      channel: "string",
      budgetPct: 0,
      rationale: "string",
    },
  ],
  goalsAlignment: "string",
  requiresApprovalCount: 0,
  autoApprovedCount: 0,
})}

Propose 8-14 agent runs that fit within the $${weeklyBudgetUsd} budget.
Set autoApprove to true for agents costing under $${autoApproveThreshold} that are routine.
Set scheduledFor to realistic ISO datetime strings within the next 7 days.
Include meaningful rationale for each agent that references the business goals and current situation.
Ensure totalEstimatedCost, requiresApprovalCount, and autoApprovedCount are accurate tallies.`;

  const message = await client.messages.create({
    model: "claude-sonnet-5-20251015",
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText =
    message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  // Sonnet 5 pricing: $3/M input, $15/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
