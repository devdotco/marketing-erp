import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const outboundStrategistHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const input = (run.input ?? {}) as Record<string, unknown>;

  const prospect = (input.prospect ?? config.prospect ?? {}) as Record<string, unknown>;
  const playSlug = (input.playSlug ?? config.playSlug ?? "DEV-01") as string;

  if (!prospect.email) {
    const output = { error: "No prospect provided in run.input.prospect", playSlug };
    return { output, costUsd: 0 };
  }

  // Fetch the OutboundPlay for this workspace + slug
  let play = await prisma.outboundPlay.findUnique({
    where: { workspaceId_slug: { workspaceId: run.agentConfig.workspaceId, slug: playSlug } },
  });
  if (!play) {
    // Auto-create the play record if it doesn't exist yet
    const playNames: Record<string, string> = {
      "DEV-01": "SaaS Engineering Capacity",
      "DEV-02": "Agency White-Label Fulfillment",
      "DEV-03": "PE-Backed Modernization",
    };
    play = await prisma.outboundPlay.create({
      data: {
        workspaceId: run.agentConfig.workspaceId,
        slug: playSlug,
        name: playNames[playSlug] ?? playSlug,
        enabled: true,
      },
    });
  }

  const systemPrompt = `You are an ICP scoring specialist for Dev.co, a software development agency.

Your job is to score a single prospect against Dev.co's ICP criteria and generate a Prospect Intelligence Object used by the email and LinkedIn outreach agents.

Score the prospect across exactly these six dimensions (max points shown):
1. Observable pain / trigger signal: 0-25 points
2. Dev.co service fit: 0-20 points
3. Firmographic fit: 0-25 points
4. Persona fit: 0-15 points
5. Timing indicators: 0-10 points
6. Data quality: 0-5 points

Channel routing rules:
- 80+: EMAIL_AND_LINKEDIN
- 65-79: EMAIL_ONLY
- 50-64: WATCHLIST
- <50: DISCARDED

Always respond with valid JSON only — no markdown, no commentary.`;

  const userPrompt = `Score this prospect for play ${playSlug} and generate their Prospect Intelligence Object.

Prospect data:
${JSON.stringify(prospect, null, 2)}

Return exactly this JSON structure:
{
  "scoring": {
    "total": 0,
    "signal": 0,
    "serviceFit": 0,
    "firmographic": 0,
    "persona": 0,
    "timing": 0,
    "dataQuality": 0,
    "routing": "EMAIL_AND_LINKEDIN" | "EMAIL_ONLY" | "WATCHLIST" | "DISCARDED",
    "scoringRationale": "2-3 sentence explanation of the score"
  },
  "intelligence": {
    "painHypothesis": "string — 1 sentence describing the core pain this company likely has",
    "primarySignal": "string — the single strongest signal that makes this prospect worth contacting",
    "bestOffer": "string — the specific Dev.co offer that maps to their situation",
    "messagingAngle": "string — the angle that will resonate (NOT generic outsourcing)",
    "avoid": "string — what NOT to say in outreach to this prospect",
    "proofPoints": ["string — 1-2 social proof points that would resonate with this type of buyer"],
    "companyContext": "string — compact 1-sentence context about the company for agent memory"
  }
}`;

  const message = await client.messages.create({
    model: "claude-sonnet-5-20251015",
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let scored: Record<string, unknown>;
  try {
    scored = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    scored = {};
  }

  const scoring = (scored.scoring ?? {}) as Record<string, unknown>;
  const total = typeof scoring.total === "number" ? scoring.total : 0;
  const routing = (scoring.routing as string) ?? "WATCHLIST";

  const channelMap: Record<string, "EMAIL_AND_LINKEDIN" | "EMAIL_ONLY" | "WATCHLIST" | "DISCARDED"> = {
    EMAIL_AND_LINKEDIN: "EMAIL_AND_LINKEDIN",
    EMAIL_ONLY: "EMAIL_ONLY",
    WATCHLIST: "WATCHLIST",
    DISCARDED: "DISCARDED",
  };

  // Upsert prospect into DB
  const dbProspect = await prisma.outboundProspect.upsert({
    where: {
      workspaceId_email: {
        workspaceId: run.agentConfig.workspaceId,
        email: (prospect.email as string).toLowerCase(),
      },
    },
    create: {
      workspaceId: run.agentConfig.workspaceId,
      playId: play.id,
      firstName: (prospect.firstName as string) ?? "",
      lastName: prospect.lastName as string | undefined,
      email: (prospect.email as string).toLowerCase(),
      linkedInUrl: prospect.linkedInUrl as string | undefined,
      title: prospect.title as string | undefined,
      company: (prospect.company as string) ?? "",
      companyDomain: prospect.companyDomain as string | undefined,
      score: total,
      channel: channelMap[routing] ?? "WATCHLIST",
      intelligence: JSON.parse(JSON.stringify(scored)),
    },
    update: {
      score: total,
      channel: channelMap[routing] ?? "WATCHLIST",
      intelligence: JSON.parse(JSON.stringify(scored)),
    },
  });

  const output: Record<string, unknown> = {
    prospectId: dbProspect.id,
    prospect: {
      firstName: prospect.firstName,
      lastName: prospect.lastName,
      email: prospect.email,
      company: prospect.company,
      title: prospect.title,
    },
    scoring,
    intelligence: scored.intelligence,
    routing,
    generatedAt: new Date().toISOString(),
    workspaceId: run.agentConfig.workspaceId,
  };

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};
