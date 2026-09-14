import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
import { decryptCredentials } from "@/lib/crypto";
import { resolveProfile } from "@/lib/content/editorial";
import { bareDomain, fetchAhrefsBacklinks, fetchSemrushDomainOrganic, resolveSeoLiveData } from "./seo-data-providers";
import {
  filterProspectsForOutreach,
  generateOutreachSequence,
  stageProspectorInstantlyCampaign,
  coerceSendDay,
  resolveSendWindow,
} from "./prospector-outreach";

export const prospectorHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);
  const sendViaInstantly = config.sendViaInstantly === true;

  // Refuse before spending a single token if the run is configured to stage a campaign it can't
  // actually reach — same pattern as Email Marketing's platform check (email-marketing.ts).
  let instantlyIntegration: Awaited<ReturnType<typeof prisma.integration.findUnique>> = null;
  if (sendViaInstantly) {
    instantlyIntegration = await prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "INSTANTLY" } },
    });
    if (!instantlyIntegration) {
      throw new AgentInputError(
        "Outreach via Instantly is turned on, but Instantly isn't connected for this workspace.",
        "Connect it under Settings → Integrations → Instantly, or turn off Outreach via Instantly before running Prospector. See the Instantly setup guide for what's needed.",
        "instantly_not_connected",
      );
    }
  }
  const targetTopics = String(config.targetTopics ?? "");
  const domainRatingMin = Number(config.domainRatingMin ?? 30);
  const trafficMin = Number(config.trafficMin ?? 1000);
  const prospectCount = Number(config.prospectCount ?? 30);
  const excludeDomains = String(config.excludeDomains ?? "");
  const linkType = String(config.linkType ?? "Any");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.uniqueValueProp ? `Unique value proposition: ${businessProfile.uniqueValueProp}` : "",
        businessProfile.competitors.length > 0 ? `Competitors: ${businessProfile.competitors.join(", ")}` : "",
      ].filter(Boolean).join("\n")
    : "";

  // --- Live API: Ahrefs → Semrush ---
  // Use competitor domains from business profile as backlink targets to surface real prospects
  let liveDataSection = "";
  const competitorTargets = businessProfile?.competitors ?? [];
  const competitorDomains = competitorTargets.slice(0, 2).map(bareDomain).filter(Boolean);

  const liveResult = competitorDomains.length === 0
    ? ({ source: "simulation" } as const)
    : await resolveSeoLiveData(
        run.agentConfig.workspaceId,
        (data, provider) =>
          provider === "AHREFS"
            ? `\n\nLIVE AHREFS BACKLINK DATA for competitor domains:\n${JSON.stringify(data, null, 2)}\n\nThe domains linking to our competitors are prime link prospects. Include the highest-DR, most topically relevant referring domains from this data as your top prospects. Use the real DR values and domains from this data wherever possible.`
            : `\n\nLIVE SEMRUSH COMPETITOR ORGANIC DATA (columns: Ph=keyword, Po=position, Nq=monthly searches, Cp=CPC):\n${JSON.stringify(data, null, 2)}\n\nUse this data to identify topically relevant domains and realistic traffic/DR estimates for link prospects in this niche.`,
        {
          ahrefs: async (apiKey) =>
            Promise.all(competitorDomains.map(async (domain) => ({
              competitor: domain,
              backlinks: await fetchAhrefsBacklinks(apiKey, domain),
            }))),
          semrush: async (apiKey) =>
            Promise.all(competitorDomains.map(async (domain) => ({
              domain,
              data: await fetchSemrushDomainOrganic(apiKey, domain),
            }))).then((r) => JSON.stringify(r)),
        },
      );
  const source = liveResult.source;
  if (liveResult.source === "live") liveDataSection = liveResult.section;
  // --- End live API ---

  const systemPrompt = [
    "You are a link building prospector specialising in finding high-quality, topically relevant link opportunities.",
    "Quality over quantity. A domain with DR 40 and 5k monthly traffic in the exact niche beats a DR 70 site with 200k traffic in an unrelated niche.",
    "Flag any site that looks like a PBN, link farm, or guest post mill.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const userPrompt = [
    `Generate ${prospectCount} link building prospects for the following criteria.`,
    liveDataSection,
    targetTopics ? `Target topics / niche: ${targetTopics}` : "",
    `Minimum estimated Domain Rating: ${domainRatingMin}`,
    `Minimum estimated monthly traffic: ${trafficMin}`,
    `Preferred link type: ${linkType}`,
    excludeDomains ? `Exclude these domains (and any close variants): ${excludeDomains}` : "",
    "",
    "For each prospect, identify a specific page and placement opportunity. Estimate DR and monthly traffic realistically based on the site's niche and typical metrics.",
    "Mark topical relevance honestly — only use 'high' for sites where the niche match is very tight.",
    "If a site pattern suggests a PBN or link farm, include it in excludedCount and do not list it as a prospect.",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      totalFound: 0,
      prospects: [
        {
          domain: "example.com",
          pageUrl: "https://example.com/relevant-page",
          pageTitle: "Page title",
          estimatedDR: 0,
          estimatedMonthlyTraffic: 0,
          linkType: "Editorial",
          topicalRelevance: "high",
          contactEmail: null,
          contactName: null,
          outreachAngle: "Why this site would benefit from linking to you",
          linkPlacementOpportunity: "Specific sentence or section where the link fits naturally",
        },
      ],
      qualityScore: 0,
      excludedCount: 0,
      simulationNote:
        "Connect Ahrefs or Semrush in Settings to pull real domain metrics. These prospects are AI-generated based on your niche.",
    }),
  ].filter(Boolean).join("\n");

  const message = await client.messages.create({
    model: MODELS.fast,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { rawText };
  } catch {
    output = { rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;
  output.source = source;
  if (source === "live") {
    delete output.simulationNote;
  }
  // Priced from lib/ai/models.ts — Haiku 4.5 is $1/M input, $5/M output.
  let costUsd = estimateCostUsd(MODELS.fast, message.usage);

  // --- Outreach via Instantly: stage a Draft campaign with this run's prospects. Nothing sends —
  // see lib/agent-handlers/prospector-outreach.ts for why — until a human approves the run
  // (lib/agent-handlers/on-approve.ts activates it). A staging failure is recorded on
  // `channelDelivery`, NOT thrown: the prospect list above is genuine either way, and an uncaught
  // throw here would replace this run's whole output with just the error.
  if (sendViaInstantly && instantlyIntegration) {
    try {
      const editorialProfile = await prisma.editorialProfile.findUnique({
        where: { workspaceId: run.agentConfig.workspaceId },
      });
      const profile = resolveProfile(editorialProfile?.preset, editorialProfile?.overrides);

      const sequenceSteps = Math.min(4, Math.max(1, Math.round(Number(config.sequenceSteps ?? 3)) || 3));
      const stepDelayDays = Math.max(1, Math.round(Number(config.stepDelayDays ?? 3)) || 3);
      const outreachAngle = String(config.outreachAngle ?? "").trim();
      const offer = String(config.offer ?? "").trim();
      const senderName = String(config.senderName ?? "").trim();
      const senderSignature = String(config.senderSignature ?? "").trim();
      const sendingAccounts = [
        ...new Set(
          String(config.sendingAccounts ?? "")
            .split(/[\n,]+/)
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean),
        ),
      ];
      const campaignNameInput = String(config.instantlyCampaignName ?? "").trim();
      const campaignName = campaignNameInput || `Prospector Outreach – ${new Date().toISOString().slice(0, 10)}`;

      const { leads, skipped } = filterProspectsForOutreach(output.prospects, 100);

      const { steps, costUsd: sequenceCostUsd } = await generateOutreachSequence(client, {
        steps: sequenceSteps,
        outreachAngle,
        offer,
        senderName,
        senderSignature,
        profile,
      });
      costUsd += sequenceCostUsd;

      const creds = await decryptCredentials<{ apiKey: string }>(instantlyIntegration.encryptedCredentials);
      const channel = await stageProspectorInstantlyCampaign(creds.apiKey, {
        campaignName,
        steps,
        stepDelayDays,
        leads,
        skipped,
        sendingAccounts,
        sendDayOfWeek: coerceSendDay(config.sendDayOfWeek),
        timing: resolveSendWindow(config.sendWindow),
        timezone: String(config.timezone ?? "").trim() || undefined,
      });
      output.channelDelivery = { platform: "INSTANTLY", status: "staged", instantly: channel };
    } catch (err) {
      const isInputError = err instanceof AgentInputError;
      output.channelDelivery = {
        platform: "INSTANTLY",
        status: "error",
        error: {
          message: isInputError ? err.message : err instanceof Error ? err.message : String(err),
          hint: isInputError ? err.hint : undefined,
          code: isInputError ? err.code : "channel_stage_failed",
        },
      };
    }
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval || sendViaInstantly) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
