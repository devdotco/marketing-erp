import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export const onSitePublisherHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const cmsTarget = String(config.cmsTarget ?? "WordPress");
  const publishStatus = String(config.publishStatus ?? "Draft");
  const draftId = String(config.draftId ?? "");
  const primaryCategory = String(config.primaryCategory ?? "");
  const overwriteExisting = config.overwriteExisting === true;

  // In production this handler would:
  // 1. Fetch the approved draft from the AgentRun by draftId
  // 2. Authenticate with the CMS via the workspace Integration credentials
  // 3. Upload media assets to the CMS media library
  // 4. Map content fields to CMS schema (WordPress REST API / Storyblok Management API / Webflow CMS API)
  // 5. Inject SEO metadata and schema.org JSON-LD
  // 6. POST/PUT to CMS and retrieve the live URL

  const systemPrompt = [
    "You are a CMS integration specialist.",
    "Given a content brief, you produce the exact API payload needed to publish to the specified CMS.",
    "You handle field mapping, media references, SEO metadata, and schema markup.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
  ].join("\n");

  const userPrompt = [
    `Simulate publishing a content draft to ${cmsTarget}.`,
    `Draft ID: ${draftId || "latest approved draft"}`,
    `Publish status: ${publishStatus}`,
    primaryCategory ? `Category/collection: ${primaryCategory}` : "",
    overwriteExisting ? "Overwrite mode: enabled" : "Overwrite mode: disabled",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      status: "success",
      cmsTarget,
      publishStatus,
      postId: "12345",
      liveUrl: "https://example.com/blog/article-slug",
      stagedAt: new Date().toISOString(),
      uploadedMedia: [
        { originalUrl: "https://...", cmsUrl: "https://example.com/wp-content/uploads/image.webp", altText: "Description" },
      ],
      seoMetadata: {
        title: "Article title | Site name",
        metaDescription: "150-160 char meta description",
        canonical: "https://example.com/blog/article-slug",
        ogTitle: "Open Graph title",
        ogDescription: "Open Graph description",
      },
      schemaMarkup: {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": "Article headline",
        "datePublished": new Date().toISOString(),
      },
      fieldMappingLog: [
        { field: "title", source: "draft.title", destination: `${cmsTarget} title field`, status: "mapped" },
        { field: "content", source: "draft.content", destination: `${cmsTarget} body field`, status: "mapped" },
        { field: "slug", source: "draft.slug", destination: `${cmsTarget} permalink`, status: "mapped" },
      ],
      warnings: [],
    }),
  ].filter(Boolean).join("\n");

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.note = "Simulated publish — connect a live CMS integration in Settings to enable real deployment.";

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
