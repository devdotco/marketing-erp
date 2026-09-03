import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

export const blogWriterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const wordCount = Number(config.wordCount ?? 1500);
  const targetKeyword = String(config.targetKeyword ?? "");
  const topicBrief = String(config.topicBrief ?? "");
  const audienceDescription = String(config.audienceDescription ?? "");
  const toneOverride = String(config.toneOverride ?? "Use Brand Profile default");
  const cmsTarget = String(config.cmsTarget ?? "None (draft only)");
  const competitorUrls = String(config.competitorUrls ?? "");
  const includeStatistics = config.includeStatistics !== false;

  // Fetch business profile for brand voice context
  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.brandVoice ? `Brand voice: ${businessProfile.brandVoice}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
      ].filter(Boolean).join("\n")
    : "";

  const effectiveTone =
    toneOverride === "Use Brand Profile default"
      ? (businessProfile?.brandVoice ?? "professional and helpful")
      : toneOverride.toLowerCase();

  const systemPrompt = [
    "You are an expert SEO content writer.",
    "You write publication-ready articles that rank in search engines and genuinely help readers.",
    "Always verify statistics mentally before including them — prefer well-known, citable sources.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const userPrompt = [
    `Write a ${wordCount}-word SEO-optimised blog article.`,
    targetKeyword ? `Primary keyword: "${targetKeyword}" — use naturally in title, first 100 words, and 2-3 subheadings.` : "",
    topicBrief ? `Topic brief: ${topicBrief}` : "",
    audienceDescription ? `Reader: ${audienceDescription}` : "",
    `Tone: ${effectiveTone}`,
    includeStatistics ? "Include specific, cited statistics from authoritative sources where they strengthen claims." : "Avoid third-party statistics.",
    competitorUrls ? `Cover angles these competitor articles miss:\n${competitorUrls}` : "",
    cmsTarget !== "None (draft only)" ? `Format the HTML output for ${cmsTarget} (use standard heading tags and <p> tags, no inline styles).` : "",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      title: "SEO-optimised article title",
      slug: "url-friendly-slug",
      metaDescription: "150-160 character meta description",
      focusKeyword: targetKeyword || "primary keyword",
      content: "<h1>...</h1><p>...</p>... (full HTML body)",
      wordCount: 0,
      estimatedReadMinutes: 0,
      internalLinkPlaceholders: ["[[relevant topic]]"],
      citations: [{ claim: "stat or claim", source: "Source name (year)", url: "https://..." }],
    }),
  ].filter(Boolean).join("\n");

  const message = await client.messages.create({
    model: "claude-sonnet-5-20251015",
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { content: rawText };
  } catch {
    output = { content: rawText };
  }

  output.cmsTarget = cmsTarget;
  output.generatedAt = new Date().toISOString();

  // Sonnet 5 pricing: $3/M input, $15/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  // Auto-publish to CMS when approval is not required and an integration is configured
  if (!requireApproval) {
    const [wpIntegration, storyblokIntegration, webflowIntegration] = await Promise.all([
      prisma.integration.findUnique({
        where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "WORDPRESS" } },
      }),
      prisma.integration.findUnique({
        where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "STORYBLOK" } },
      }),
      prisma.integration.findUnique({
        where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "WEBFLOW" } },
      }),
    ]);

    const postTitle = String(output.title ?? "Untitled Post");
    const postSlug = String(
      output.slug ??
      postTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    );
    const postContent = String(output.content ?? "");
    const postMetaDesc = String(output.metaDescription ?? "");

    // WordPress live publish
    if (wpIntegration && postContent) {
      try {
        const creds = await decryptCredentials<{ siteUrl: string; username: string; applicationPassword: string }>(
          wpIntegration.encryptedCredentials
        );
        const resp = await fetch(`${creds.siteUrl}/wp-json/wp/v2/posts`, {
          method: "POST",
          headers: {
            Authorization: "Basic " + btoa(`${creds.username}:${creds.applicationPassword}`),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: postTitle,
            content: postContent,
            status: "draft",
            categories: [],
            tags: [],
            meta: { _yoast_wpseo_title: postTitle, _yoast_wpseo_metadesc: postMetaDesc },
          }),
        });
        if (!resp.ok) throw new Error(`WordPress API ${resp.status}: ${await resp.text()}`);
        const result = await resp.json() as { id: number; link: string; status: string };
        output.cmsPublish = {
          source: "live",
          cmsTarget: "WordPress",
          publishStatus: result.status,
          postId: String(result.id),
          liveUrl: result.link,
          publishedAt: new Date().toISOString(),
        };
      } catch {
        // Non-fatal: content is still returned even if CMS publish fails
      }
    } else if (storyblokIntegration && postContent) {
      // Storyblok live publish
      try {
        const creds = await decryptCredentials<{ spaceId: string; managementToken: string }>(
          storyblokIntegration.encryptedCredentials
        );
        const resp = await fetch(`https://mapi.storyblok.com/v1/spaces/${creds.spaceId}/stories/`, {
          method: "POST",
          headers: {
            Authorization: creds.managementToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            story: {
              name: postTitle,
              slug: postSlug,
              content: {
                component: "blog_post",
                title: postTitle,
                body: postContent,
                meta_title: postTitle,
                meta_description: postMetaDesc,
              },
            },
          }),
        });
        if (!resp.ok) throw new Error(`Storyblok API ${resp.status}: ${await resp.text()}`);
        const result = await resp.json() as { story: { id: number; full_slug: string } };
        output.cmsPublish = {
          source: "live",
          cmsTarget: "Storyblok",
          publishStatus: "draft",
          postId: String(result.story.id),
          liveUrl: `https://app.storyblok.com/#!/me/spaces/${creds.spaceId}/stories/0/0/${result.story.id}`,
          publishedAt: new Date().toISOString(),
        };
      } catch {
        // Non-fatal: content is still returned even if CMS publish fails
      }
    } else if (webflowIntegration && postContent) {
      // Webflow live publish
      try {
        const creds = await decryptCredentials<{ siteId: string; collectionId: string; apiToken: string }>(
          webflowIntegration.encryptedCredentials
        );
        const resp = await fetch(`https://api.webflow.com/v2/collections/${creds.collectionId}/items`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${creds.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            isArchived: false,
            isDraft: true,
            fieldData: { name: postTitle, slug: postSlug, "post-body": postContent },
          }),
        });
        if (!resp.ok) throw new Error(`Webflow API ${resp.status}: ${await resp.text()}`);
        const result = await resp.json() as { id: string };
        output.cmsPublish = {
          source: "live",
          cmsTarget: "Webflow",
          publishStatus: "draft",
          postId: result.id,
          liveUrl: `https://webflow.com/design/${creds.siteId}`,
          publishedAt: new Date().toISOString(),
        };
      } catch {
        // Non-fatal: content is still returned even if CMS publish fails
      }
    }
  }

  return { output, costUsd };
};
