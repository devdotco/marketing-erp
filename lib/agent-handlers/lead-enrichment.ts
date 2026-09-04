import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

export const leadEnrichmentHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const leadEmail = (config.leadEmail as string) ?? "";
  const leadName = (config.leadName as string) ?? "";
  const leadCompany = (config.leadCompany as string) ?? "";
  const icpCriteria = (config.icpCriteria as string) ?? "";
  const flagHighPriority = (config.flagHighPriority as boolean) ?? true;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const apolloIntegration = await prisma.integration.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: run.agentConfig.workspaceId,
        provider: "APOLLO",
      },
    },
  });

  // ── Live Apollo enrichment path ──────────────────────────────────────────
  type ApolloOrg = {
    name?: string;
    primary_domain?: string;
    industry?: string;
    estimated_num_employees?: number;
    annual_revenue?: number;
    annual_revenue_printed?: string;
    funding_stage?: string;
    technology_names?: string[];
    linkedin_url?: string;
    website_url?: string;
    founded_year?: number;
    city?: string;
    country?: string;
    description?: string;
    current_technologies?: Array<{ name: string; category: string }>;
  };
  type ApolloPerson = {
    id?: string;
    first_name?: string;
    last_name?: string;
    name?: string;
    linkedin_url?: string;
    title?: string;
    city?: string;
    state?: string;
    country?: string;
    departments?: string[];
    seniority?: string;
    email_status?: string;
    organization?: ApolloOrg;
  };

  let apolloData: ApolloPerson | null = null;
  let isLive = false;

  if (apolloIntegration && leadEmail) {
    try {
      const creds = await decryptCredentials<{ api_key: string }>(
        apolloIntegration.encryptedCredentials
      );

      const nameParts = leadName.trim().split(" ");
      const matchBody: Record<string, string> = {
        api_key: creds.api_key,
        email: leadEmail,
      };
      if (nameParts.length >= 1 && nameParts[0]) matchBody.first_name = nameParts[0];
      if (nameParts.length >= 2) matchBody.last_name = nameParts.slice(1).join(" ");
      if (leadCompany) matchBody.organization_name = leadCompany;

      const apolloRes = await fetch("https://api.apollo.io/v1/people/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(matchBody),
      });

      if (apolloRes.ok) {
        const apolloJson = (await apolloRes.json()) as { person?: ApolloPerson };
        if (apolloJson.person) {
          apolloData = apolloJson.person;
          isLive = true;
        }
      }
    } catch {
      // Fall through to Claude simulation
    }
  }

  let output: Record<string, unknown>;
  let inputTokens = 0;
  let outputTokens = 0;

  if (isLive && apolloData) {
    // ── Map Apollo response to enrichment schema ───────────────────────────
    const org = apolloData.organization ?? {};
    const seniority = apolloData.seniority ?? "unknown";
    const title = apolloData.title ?? "";

    const seniorityMap: Record<string, string> = {
      c_suite: "C-Suite", vp: "VP", director: "Director",
      manager: "Manager", senior: "IC", entry: "IC", ic: "IC",
    };
    const decisionPower =
      ["c_suite", "vp"].includes(seniority) ? "high" :
      seniority === "director" ? "medium" : "low";

    const empCount = org.estimated_num_employees ?? 0;
    const empRange =
      empCount < 11 ? "1-10" : empCount < 51 ? "11-50" : empCount < 201 ? "51-200" :
      empCount < 501 ? "201-500" : empCount < 1001 ? "501-1000" : "1000+";

    const techConfirmed = (org.current_technologies ?? []).map((t) => ({
      tool: t.name,
      category: t.category,
      source: "Apollo",
    }));
    const techNames = org.technology_names ?? [];
    const techInferred = techNames
      .filter((n) => !techConfirmed.find((c) => c.tool === n))
      .slice(0, 5)
      .map((n) => ({ tool: n, category: "Detected", confidence: "medium" as const }));

    output = {
      lead: {
        email: leadEmail,
        name: apolloData.name ?? leadName,
        inferredFirstName: apolloData.first_name ?? "",
        inferredLastName: apolloData.last_name ?? "",
        linkedinUrl: apolloData.linkedin_url ?? null,
        avatarInitials: [apolloData.first_name?.[0], apolloData.last_name?.[0]].filter(Boolean).join("").toUpperCase() || "?",
      },
      role: {
        inferredTitle: title,
        seniority: seniorityMap[seniority] ?? "Unknown",
        department: (apolloData.departments ?? [])[0] ?? "Unknown",
        isBuyer: ["c_suite", "vp", "director"].includes(seniority),
        isInfluencer: ["manager", "senior", "ic"].includes(seniority),
        isEndUser: seniority === "ic",
        decisionMakingPower: decisionPower,
        confidenceScore: apolloData.email_status === "verified" ? 0.9 : 0.65,
      },
      company: {
        name: org.name ?? leadCompany,
        domain: org.primary_domain ?? leadEmail.split("@")[1] ?? "",
        industry: org.industry ?? "Unknown",
        subIndustry: "",
        employeeRange: empRange,
        estimatedEmployees: empCount,
        revenueRange: org.annual_revenue_printed ?? "",
        fundingStage: org.funding_stage ?? "Unknown",
        totalFundingUsd: 0,
        foundedYear: org.founded_year ?? null,
        hqCountry: org.country ?? apolloData.country ?? "",
        hqCity: org.city ?? apolloData.city ?? "",
        websiteUrl: org.website_url ?? "",
        linkedinCompanyUrl: org.linkedin_url ?? "",
        description: org.description ?? "",
        growth: {
          headcountGrowth12m: "",
          jobPostingsTrend: "stable",
          techInvestmentSignals: techNames.slice(0, 3),
        },
      },
      techStack: {
        confirmed: techConfirmed,
        inferred: techInferred,
        relevantToUs: [],
      },
      icpScoring: {
        overallScore: decisionPower === "high" && empCount >= 50 ? 80 : decisionPower === "medium" ? 60 : 40,
        maxScore: 100,
        grade: decisionPower === "high" && empCount >= 50 ? "A" : decisionPower === "medium" ? "B" : "C",
        breakdown: [
          { criterion: "Seniority", weight: 30, score: decisionPower === "high" ? 30 : decisionPower === "medium" ? 20 : 10, maxScore: 30, reasoning: `${seniorityMap[seniority] ?? "Unknown"} level` },
          { criterion: "Company size", weight: 25, score: empCount >= 50 ? 25 : empCount >= 20 ? 15 : 5, maxScore: 25, reasoning: `${empRange} employees` },
          { criterion: "Email verified", weight: 20, score: apolloData.email_status === "verified" ? 20 : 8, maxScore: 20, reasoning: `Email status: ${apolloData.email_status ?? "unknown"}` },
        ],
        icpTier: decisionPower === "high" && empCount >= 50 ? "Tier 1" : decisionPower === "medium" ? "Tier 2" : "Tier 3",
        fitSummary: `${apolloData.name ?? leadName} is a ${seniorityMap[seniority] ?? "unknown seniority"} at ${org.name ?? leadCompany}. ${decisionPower === "high" ? "Strong buying authority." : "Moderate buying influence."}`,
        disqualifiers: empCount < 10 ? ["Company may be too small"] : [],
      },
      intent: {
        signals: [],
        inferredPainPoints: [],
        inferredBuyingStage: "Unknown",
        estimatedTimelineToDecision: "Unknown",
      },
      prioritisation: {
        isHighPriority: flagHighPriority && decisionPower !== "low",
        priorityReason: decisionPower === "high" ? "Decision-maker at a qualified company" : "Influencer role",
        recommendedNextAction: decisionPower === "high" ? "Prioritise AE outreach within 24h" : "Enrol in SDR sequence",
        suggestedOwner: decisionPower === "high" ? "AE" : "SDR",
        outreachPersonalisation: {
          openingHook: `Hi ${apolloData.first_name ?? "there"}, I noticed you're ${title ? `working as ${title}` : "at"} ${org.name ?? leadCompany}…`,
          valuePropAngle: businessProfile?.uniqueValueProp ?? "our core value proposition",
          avoidTopics: [],
        },
      },
      enrichmentMeta: {
        sourcesConsulted: ["Apollo.io"],
        confidenceLevel: apolloData.email_status === "verified" ? "high" : "medium",
        lastEnrichedAt: new Date().toISOString(),
        enrichmentVersion: "2.0",
        apolloPersonId: apolloData.id,
      },
      source: "live",
    };
  } else {
    // ── Claude simulation fallback ─────────────────────────────────────────
    const systemPrompt = `You are an expert B2B lead intelligence analyst. Given minimal lead information, you produce rich enrichment profiles including company firmographics, likely tech stack, role inference, ICP fit scoring, and prioritisation signals. Always respond with valid JSON only — no markdown fences, no text outside the JSON object.`;

    const userPrompt = `Enrich the following inbound lead and score their ICP fit.

Lead Information:
- Email: ${leadEmail}
- Name: ${leadName || "(not provided)"}
- Company: ${leadCompany || "(infer from email domain)"}

Our Business Context:
- Company: ${businessProfile?.businessName ?? "our company"}
- Industry: ${businessProfile?.industry ?? "SaaS"}
- Target Market: ${businessProfile?.targetAudience ?? "mid-market B2B"}
- Value Proposition: ${businessProfile?.uniqueValueProp ?? "AI-driven marketing automation"}

ICP Criteria:
${icpCriteria || "Company size 50-500 employees, SaaS or tech sector, decision-maker or influencer role, English-speaking market, growth-stage company with marketing budget."}

Flag as High Priority: ${flagHighPriority}

Return JSON matching this exact shape (no markdown, no code fences):
{
  "lead": { "email": "${leadEmail}", "name": "...", "inferredFirstName": "...", "inferredLastName": "...", "linkedinUrl": "...", "avatarInitials": ".." },
  "role": { "inferredTitle": "...", "seniority": "C-Suite|VP|Director|Manager|IC|Unknown", "department": "...", "isBuyer": true, "isInfluencer": true, "isEndUser": false, "decisionMakingPower": "high|medium|low", "confidenceScore": 0.0 },
  "company": { "name": "...", "domain": "...", "industry": "...", "subIndustry": "...", "employeeRange": "...", "estimatedEmployees": 0, "revenueRange": "...", "fundingStage": "Bootstrap|Seed|Series A|Series B|Series C|Public|Unknown", "totalFundingUsd": 0, "foundedYear": 0, "hqCountry": "...", "hqCity": "...", "websiteUrl": "...", "linkedinCompanyUrl": "...", "description": "...", "growth": { "headcountGrowth12m": "...", "jobPostingsTrend": "increasing|stable|decreasing", "techInvestmentSignals": [] } },
  "techStack": { "confirmed": [], "inferred": [], "relevantToUs": [] },
  "icpScoring": { "overallScore": 0, "maxScore": 100, "grade": "A|B|C|D", "breakdown": [], "icpTier": "Tier 1|Tier 2|Tier 3|Disqualified", "fitSummary": "...", "disqualifiers": [] },
  "intent": { "signals": [], "inferredPainPoints": [], "inferredBuyingStage": "Awareness|Consideration|Decision|Unknown", "estimatedTimelineToDecision": "..." },
  "prioritisation": { "isHighPriority": ${flagHighPriority}, "priorityReason": "...", "recommendedNextAction": "...", "suggestedOwner": "AE|SDR|Marketing Nurture|No Action", "outreachPersonalisation": { "openingHook": "...", "valuePropAngle": "...", "avoidTopics": [] } },
  "enrichmentMeta": { "sourcesConsulted": ["AI inference"], "confidenceLevel": "high|medium|low", "lastEnrichedAt": "${new Date().toISOString()}", "enrichmentVersion": "1.0" },
  "source": "simulation",
  "simulationNote": "Connect Apollo in Settings > Integrations to enable live person and company enrichment from Apollo.io's database of 275M+ contacts."
}`;

    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    inputTokens = message.usage.input_tokens;
    outputTokens = message.usage.output_tokens;

    const rawText = message.content[0].type === "text" ? message.content[0].text : "";
    const jsonMatch = rawText.match(/\{[\s\S]+\}/);
    try {
      output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
    } catch {
      output = { result: rawText };
    }
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = isLive ? 0 : (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;
  return { output, costUsd };
};
