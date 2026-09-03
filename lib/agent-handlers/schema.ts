import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const schemaHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const siteUrl = String(config.siteUrl ?? "");
  const pageTypes = String(config.pageTypes ?? "All");
  const validationStrictness = String(config.validationStrictness ?? "Standard");
  const cmsTarget = String(config.cmsTarget ?? "HTML");
  const customSchemaTypes = String(config.customSchemaTypes ?? "");

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

  const resolvedPageTypes =
    pageTypes === "All"
      ? ["Homepage", "Blog Post", "FAQ", "Product/Service", "Breadcrumb", "Organization"]
      : pageTypes === "Blog only"
        ? ["Blog Post", "Breadcrumb"]
        : [pageTypes];

  const userPrompt = [
    `Generate Schema.org structured data for: ${siteUrl || "the client website"}`,
    `Page types to cover: ${resolvedPageTypes.join(", ")}`,
    `Validation strictness: ${validationStrictness} — ${validationStrictness === "Strict" ? "only include properties with confirmed Google support" : "include recommended properties even if not all are verified by Google"}`,
    `CMS target: ${cmsTarget} — provide implementation notes specific to this platform`,
    customSchemaTypes ? `Also include these custom schema types: ${customSchemaTypes}` : "",
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
            name: "Business Name",
            url: siteUrl || "https://example.com",
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
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { schemas: rawText };
  } catch {
    output = { schemas: rawText };
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
