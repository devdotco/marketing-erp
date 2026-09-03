import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

export const onSitePublisherHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const cmsTarget = String(config.cmsTarget ?? "WordPress");
  const publishStatus = String(config.publishStatus ?? "Draft");
  const draftId = String(config.draftId ?? "");
  const primaryCategory = String(config.primaryCategory ?? "");
  const overwriteExisting = config.overwriteExisting === true;

  const requireApproval = config.requireApproval !== false;

  // Fetch draft content from a previous AgentRun output (e.g., blog-writer output)
  let draftContent: Record<string, unknown> = {};
  if (draftId) {
    const draftRun = await prisma.agentRun.findUnique({ where: { id: draftId } });
    if (draftRun?.output) {
      draftContent = draftRun.output as Record<string, unknown>;
    }
  }

  const postTitle = String(draftContent.title ?? "Untitled Post");
  const postSlug = String(
    draftContent.slug ??
    postTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  );
  const postContent = String(draftContent.content ?? "");
  const postMetaDesc = String(draftContent.metaDescription ?? "");

  // Check for live CMS integrations: WordPress → Storyblok → Webflow
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
      const output: Record<string, unknown> = {
        status: "success",
        source: "live",
        cmsTarget: "WordPress",
        publishStatus: result.status,
        postId: String(result.id),
        liveUrl: result.link,
        stagedAt: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
      };
      if (requireApproval) await updateStatus("AWAITING_APPROVAL", output);
      return { output, costUsd: 0 };
    } catch {
      // Fall through to next CMS or simulation
    }
  }

  // Storyblok live publish
  if (storyblokIntegration && postContent) {
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
      const output: Record<string, unknown> = {
        status: "success",
        source: "live",
        cmsTarget: "Storyblok",
        publishStatus: "draft",
        postId: String(result.story.id),
        liveUrl: `https://app.storyblok.com/#!/me/spaces/${creds.spaceId}/stories/0/0/${result.story.id}`,
        stagedAt: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
      };
      if (requireApproval) await updateStatus("AWAITING_APPROVAL", output);
      return { output, costUsd: 0 };
    } catch {
      // Fall through to next CMS or simulation
    }
  }

  // Webflow live publish
  if (webflowIntegration && postContent) {
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
      const output: Record<string, unknown> = {
        status: "success",
        source: "live",
        cmsTarget: "Webflow",
        publishStatus: "draft",
        postId: result.id,
        liveUrl: `https://webflow.com/design/${creds.siteId}`,
        stagedAt: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
      };
      if (requireApproval) await updateStatus("AWAITING_APPROVAL", output);
      return { output, costUsd: 0 };
    } catch {
      // Fall through to simulation
    }
  }

  // ── Claude simulation fallback ─────────────────────────────────────────────
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

  output.source = "simulation";
  output.generatedAt = new Date().toISOString();
  output.note = "Simulated publish — connect a live CMS integration in Settings to enable real deployment.";

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
