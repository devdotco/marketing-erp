import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { lines, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const schemaHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);
  // Schema Types replaced the old customSchemaTypes field on 2026-09-14; a saved value still works.
  applyRenamedInputs(run, config, { schemaTypes: "customSchemaTypes" });
  const siteUrl = String(config.siteUrl ?? "");
  const validationStrictness = str(config, "validationStrictness", "Standard");
  const cmsTarget = String(config.cmsTarget ?? "HTML");
  const schemaTypes = lines(config, "schemaTypes", 20);
  const organisationName = str(config, "organisationName");
  const organisationUrl = str(config, "organisationUrl");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business name: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
        businessProfile.goals ? `Business goals: ${JSON.stringify(businessProfile.goals)}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
      ].filter(Boolean).join("\n")
    : "";

  const systemPrompt = [
    "You are a Schema.org and structured data specialist.",
    "Generate valid JSON-LD that passes Google's Rich Results Test.",
    "Include only properties Google actually uses in search — omit decorative-only properties.",
    "For each schema, explain how to implement it in the target CMS without breaking existing markup.",
    "The llms.txt file should follow the emerging standard: a concise machine-readable summary of the site for AI crawlers.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const resolvedSchemaTypes = schemaTypes.length > 0 ? schemaTypes : ["Article", "BreadcrumbList", "FAQ"];
  const orgName = organisationName || businessProfile?.businessName || "";
  const orgUrl = organisationUrl || businessProfile?.websiteUrl || siteUrl;

  const userPrompt = [
    `Generate Schema.org structured data for: ${siteUrl || "the client website"}`,
    `Schema types to generate (only these, plus the Organization entity they reference): ${resolvedSchemaTypes.join(", ")}`,
    orgName ? `Organisation name for every Organization / publisher entity: ${orgName}` : "",
    orgUrl ? `Organisation URL for the Organization url and publisher fields: ${orgUrl}` : "",
    `Validation strictness: ${validationStrictness} — ${validationStrictness === "Strict" ? "only include properties with confirmed Google support" : "include recommended properties even if not all are verified by Google"}`,
    `CMS target: ${cmsTarget} — provide implementation notes specific to this platform`,
    "",
    "For each schema:",
    "- Provide complete, valid JSON-LD ready to paste",
    "- Note the correct placement (head vs body)",
    "- Flag any properties that need to be populated dynamically",
    validationStrictness === "Strict"
      ? "- Only include properties documented in Google Search Central"
      : "- Include all relevant Schema.org properties, flagging any Google-unverified ones",
    "",
    "Also generate:",
    "- An llms.txt file for the site (AI-readable site summary following the llms.txt spec)",
    "- A plain-English implementation guide for a developer",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      siteUrl: siteUrl || "",
      schemas: [
        {
          pageType: "Homepage",
          schemaType: "Organization + WebSite",
          jsonLd: {
            "@context": "https://schema.org",
            "@type": "Organization",
            name: orgName || "Business Name",
            url: orgUrl || "https://example.com",
          },
          implementationNote:
            "Place in <head> on every page. Replace placeholder values with real data.",
          validationStatus: "valid",
          cmsImplementation: `How to add this in ${cmsTarget}...`,
        },
      ],
      llmsTxt: "# Site Name\n\n> One-line description\n\n## About\n...\n\n## Pages\n...",
      implementationGuide:
        "Step-by-step guide for implementing all schemas on the site...",
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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { schemas: rawText };
  } catch {
    output = { schemas: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;
  // Priced from lib/ai/models.ts — Haiku 4.5 is $1/M input, $5/M output.
  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
