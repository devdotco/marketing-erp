import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { bool, num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const operatorHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);

  // Old names from before the form and handler were reconciled — see renamed-inputs.ts.
  applyRenamedInputs(run, config, {
    focusArea: {
      from: "priorityChannels",
      map: (v: unknown) => ({ "Content+SEO": "Content-heavy", "Paid+Social": "Paid-heavy", "SEO only": "SEO-heavy", All: "Balanced" } as Record<string, string>)[String(v)],
    },
    priorityOverride: "goalsContext",
  });
  const weeklyBudgetUsd = num(config, "weeklyBudgetUsd", 500, { min: 0 });
  const focusArea = str(config, "focusArea", "Balanced");
  const goalsContext = str(config, "priorityOverride");
  const planningHorizonDays = Math.round(num(config, "planningHorizonDays", 7, { min: 1, max: 30 }));
  const maxAgentRuns = Math.round(num(config, "maxAgentsPerWeek", 5, { min: 1, max: 20 }));
  const includeAnomalies = bool(config, "includeAnomalies", true);
  // Not a form input: the plan's autoApprove flags are recommendations only — nothing in the
  // platform auto-approves a run — so this stays the fixed bar it always was.
  const autoApproveThreshold = 50;

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
    focusArea === "Content-heavy"
      ? "Weight the plan toward content creation agents (blog-writer, topic-planner, repurposer, newsletter, on-site-publisher, content-refresh, landing-page-copy)."
      : focusArea === "Paid-heavy"
        ? "Weight the plan toward paid advertising agents (google-ads, meta-ads, linkedin-ads, ad-creative) and the social agents that feed them."
        : focusArea === "SEO-heavy"
          ? "Weight the plan toward SEO agents (keyword-research, technical-audit, rank-tracker, topic-planner, internal-linking, schema, content-refresh, gsc-analyst)."
          : focusArea === "Conversion optimisation"
            ? "Weight the plan toward conversion agents (landing-page-copy, attribution, email-marketing, anomaly-watch) and fixing what leaks between click and conversion."
            : "Include agents across all channels: content, SEO, paid, social, email, outreach, and analytics.";

  // Open anomalies from the latest live Anomaly Watch run. Simulated anomaly output is never fed
  // in — planning a week around invented alerts is worse than planning without any.
  let anomalySection = "";
  if (includeAnomalies) {
    const anomalyRun = await prisma.agentRun.findFirst({
      where: {
        workspaceId: run.agentConfig.workspaceId,
        agentConfig: { agentSlug: "anomaly-watch" },
        status: { in: ["COMPLETED", "APPROVED", "AWAITING_APPROVAL"] },
        createdAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      select: { output: true, createdAt: true },
    });
    const anomalyOutput = anomalyRun?.output as { source?: unknown; anomalies?: unknown } | null | undefined;
    if (anomalyOutput?.source === "live" && Array.isArray(anomalyOutput.anomalies) && anomalyOutput.anomalies.length > 0) {
      anomalySection = `Open anomaly alerts from Anomaly Watch (${anomalyRun!.createdAt.toISOString().slice(0, 10)}) — treat these as high-priority inputs:\n${JSON.stringify(anomalyOutput.anomalies).slice(0, 4000)}`;
    } else {
      anomalySection = "Anomaly alerts: none open from a live Anomaly Watch run in the last 14 days.";
    }
  }

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

Priority notes from the operator (factor these in ahead of data-driven signals):
${goalsContext || "No specific priority notes provided. Use business profile goals."}
${anomalySection ? `\n${anomalySection}\n` : ""}
Operator configuration:
- Planning horizon: ${planningHorizonDays} day${planningHorizonDays === 1 ? "" : "s"}
- Maximum agent runs in the plan: ${maxAgentRuns}
- Weekly budget: $${weeklyBudgetUsd}
- Strategic focus: ${focusArea}
- Auto-approve threshold: $${autoApproveThreshold} per run

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

Propose at most ${maxAgentRuns} agent run${maxAgentRuns === 1 ? "" : "s"} that fit within the $${weeklyBudgetUsd} budget.
Set autoApprove to true for agents costing under $${autoApproveThreshold} that are routine.
Set scheduledFor to realistic ISO datetime strings within the next ${planningHorizonDays} day${planningHorizonDays === 1 ? "" : "s"}.
Include meaningful rationale for each agent that references the business goals and current situation.
Ensure totalEstimatedCost, requiresApprovalCount, and autoApprovedCount are accurate tallies.`;

  const message = await client.messages.create({
    model: MODELS.standard,
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;
  // Priced from lib/ai/models.ts — Sonnet 5 is $2/M input, $10/M output.
  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
