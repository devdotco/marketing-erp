import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

const ICP_DEFINITIONS: Record<string, string> = {
  "DEV-01": `ICP: B2B SaaS or software companies, 50-500 employees, $10M-$250M estimated revenue, US or Canada.
Persona: CTO, VP Engineering, Head of Engineering, or Founder at the smaller end.
Top signals: 5+ open engineering roles, engineering headcount grew ≥10% past 12 months, recent Series A-C funding, new CTO <6 months, product launch, tech migration.
Offer: Supplemental development pod — flexible capacity without permanent headcount.
Disqualify: agencies, consulting firms, staffing companies, >1000 employees, <$5M revenue, hardware primary.`,

  "DEV-02": `ICP: Marketing agencies, creative agencies, or digital agencies, 10-200 employees, US/Canada/UK.
Persona: Owner, CEO, Founder, Head of Operations.
Top signals: new client wins published, project manager job postings (delivery demand signal), service expansion, case studies added <90 days.
Offer: Invisible white-label development partner — extend capacity, keep the client relationship.
Disqualify: dev agencies (competitors), SaaS companies, >500 employees.`,

  "DEV-03": `ICP: PE-backed portfolio companies, 100-2000 employees, any industry with visible tech debt.
Persona: CTO, CIO, VP Engineering, CEO.
Top signals: PE acquisition announced <18 months, platform company making add-on acquisitions, "digital transformation" language, legacy tech stack in job postings, cloud architect / DevOps roles open.
Offer: Development/modernization team — accelerate the transformation roadmap.
Disqualify: pure-play SaaS, <$25M revenue, no visible technical complexity.`,
};

export const outboundScoutHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const input = (run.input ?? {}) as Record<string, unknown>;

  const playSlug = (config.playSlug as string) ?? (input.playSlug as string) ?? "DEV-01";
  const maxProspects = typeof config.maxProspects === "number" ? config.maxProspects : 30;
  const includeSignals = config.includeSignals !== false;

  const icpDefinition = ICP_DEFINITIONS[playSlug] ?? ICP_DEFINITIONS["DEV-01"];

  // Load existing prospect emails to dedup
  const existingEmails = await prisma.outboundProspect.findMany({
    where: { workspaceId: run.agentConfig.workspaceId },
    select: { email: true },
  });
  const existingEmailSet = new Set(existingEmails.map((p) => p.email));
  const existingCount = existingEmailSet.size;

  const systemPrompt = `You are an outbound prospecting specialist for Dev.co, a software development agency that builds products for SaaS companies, agencies, and PE-backed companies.

Your job is to generate a list of realistic, ICP-matched prospects for a given outbound play. Each prospect must be a real-seeming but fictional company and contact with plausible firmographics, verified contact data, and at least one observable buying signal.

Always respond with valid JSON only — no markdown, no commentary.`;

  const userPrompt = `Generate ${maxProspects} prospect records for outbound play: ${playSlug}

ICP Definition:
${icpDefinition}

${includeSignals ? "Each prospect MUST have at least one observable buying signal listed." : ""}

Return exactly this JSON structure:
{
  "prospects": [
    {
      "firstName": "string",
      "lastName": "string",
      "email": "string (work email, use company domain)",
      "linkedInUrl": "https://linkedin.com/in/username",
      "title": "string",
      "company": "string",
      "companyDomain": "string (e.g. acmesoftware.com)",
      "employees": "50-500",
      "estimatedRevenue": "$10M-$50M",
      "industry": "string",
      "geography": "US" | "Canada" | "UK",
      "primarySignal": "string (the #1 observable buying signal)",
      "additionalSignals": ["string"],
      "dataQualityScore": 5
    }
  ],
  "playSlug": "${playSlug}",
  "sourcedAt": "ISO 8601 date string",
  "sourceNote": "Simulated ZoomInfo query — connect ZoomInfo integration in Settings to run live sourcing"
}

Generate realistic but fictional companies and contacts. Vary industries, company sizes, and signal types.`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { prospects: [], playSlug };
  } catch {
    output = { prospects: [], playSlug, parseError: rawText.slice(0, 200) };
  }

  // Filter out any that match existing emails
  const prospects = Array.isArray(output.prospects) ? output.prospects : [];
  const newProspects = prospects.filter(
    (p: Record<string, unknown>) =>
      !existingEmailSet.has((p.email as string)?.toLowerCase() ?? "")
  );

  output.prospects = newProspects;
  output.totalSourced = prospects.length;
  output.dedupedOut = prospects.length - newProspects.length;
  output.existingInDB = existingCount;
  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};
