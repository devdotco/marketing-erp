import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { missingRequiredInputs, resolveInputs, str } from "@/lib/agents/inputs";
import { AgentInputError } from "@/lib/ai/errors";
import { resolveAnthropic } from "@/lib/ai/client";
import { buildBrief } from "@/lib/content/brief";
import { resolveProfile } from "@/lib/content/editorial";
import { writeArticle } from "@/lib/content/pipeline";
import { EDITORIAL_PRESETS, NEUTRAL_PROFILE } from "@/lib/content/editorial";
import type { ContentBrief } from "@/lib/content/brief";
import {
  actualLinks,
  blockText,
  countWords,
  estimateReadMinutes,
  renderHtml,
  renderMarkdown,
  type Article,
} from "@/lib/content/article";
import {
  listPublishedPosts,
  payloadHeaders,
  rankInternalLinkCandidates,
  type PayloadCredentials,
} from "@/lib/integrations/payload";
import { assertPublicUrl } from "@/lib/integrations/public-url";

/**
 * The Blog Writer.
 *
 * Every step the agent's own page advertises — parse the brief, research and
 * verify claims, gate the draft, write it, QA it — now actually runs, in
 * lib/content. Two failures this handler used to have are structural and worth
 * naming, because they are what the 2026-09-11 QA run caught:
 *
 *  - It read `run.agentConfig.config`, which the Run modal never writes, so the
 *    Topic Brief, keyword and audience typed into the modal were discarded and
 *    the agent wrote 1500 generic words about nothing. It reads the run's own
 *    inputs now, and refuses before spending a token when the brief is blank.
 *  - It recovered the article with `message.content[0]`, which is the thinking
 *    block whenever Sonnet thinks first, and then stored `{"content": ""}` and
 *    asked a human to approve it. The article comes back through a tool call
 *    now, and an empty body cannot reach AWAITING_APPROVAL.
 */
export const blogWriterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const inputs = resolveInputs(run);

  // Check before any spend. A blank brief is not a cheap mistake to discover at
  // the end: it is a full-price article about nothing.
  const missing = missingRequiredInputs("blog-writer", inputs);
  if (missing.length > 0) {
    throw new AgentInputError(
      `This run has no ${missing.join(" and no ")}, so there is nothing to write about.`,
      "Open the agent and use Run now, which collects the brief, or save defaults under Configure first. No tokens were spent.",
      "missing_brief",
    );
  }

  const workspaceId = run.agentConfig.workspaceId;

  // The workspace's own key. Refuses here, before any spend, when there is none.
  const { client, source: keySource } = await resolveAnthropic(workspaceId);

  const [businessProfile, editorial] = await Promise.all([
    prisma.businessProfile.findFirst({ where: { workspaceId } }),
    prisma.editorialProfile.findUnique({ where: { workspaceId } }),
  ]);

  // The voice, the banned words, the structural limits and the sourcing rules
  // all belong to the workspace. A run may name a different preset for one
  // piece — a press release does not sound like a how-to — without changing
  // what the workspace writes by default.
  const presetOverride = str(inputs, "editorialProfile", "Workspace default");
  const profile = presetOverride.startsWith("Workspace default")
    ? resolveProfile(editorial?.preset, editorial?.overrides)
    : resolveProfile(presetKeyFromLabel(presetOverride), null);

  const baseBrief = buildBrief(
    inputs,
    businessProfile,
    profile,
    `${run.agentConfigId}:${inputs.targetKeyword ?? ""}`,
  );

  // Stage progress lands on the run so the run page can show where it is rather
  // than a spinner. A failed write here must never take the article down with it.
  const progress: Array<{ stage: string; detail: string; at: string }> = [];
  const report = async (stage: string, detail: string) => {
    progress.push({ stage, detail, at: new Date().toISOString() });
    try {
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { metadata: { progress } as object },
      });
    } catch {
      // Progress is a convenience, not the result.
    }
  };

  // Augment — never replace — the internal links the person typed in with a
  // few candidates picked from the workspace's own Payload posts, so the
  // writer has somewhere real to link besides whatever was typed by hand.
  // Every entry added here becomes a QC-enforced link target (lib/content/qc.ts
  // treats brief.internalLinks as required), so this stays small and is best
  // effort: a Payload connection that fails to list posts must not take the
  // whole run down over what is, for Blog Writer, a nice-to-have.
  const brief = await augmentInternalLinksFromPayload(workspaceId, baseBrief, report);

  const result = await writeArticle(client, brief, report);
  const { article, qc, research, externalLinkBudget, stages, costUsd, repairRounds } = result;

  const html = renderHtml(article);

  const output: Record<string, unknown> = {
    title: article.title,
    slug: article.slug,
    metaDescription: article.metaDescription,
    focusKeyword: article.focusKeyword,
    content: html,
    markdown: renderMarkdown(article),
    wordCount: article.wordCount,
    estimatedReadMinutes: estimateReadMinutes(article),
    outline: article.sections.map((section) => ({
      heading: section.heading,
      words: countWords(section.blocks.map(blockText).join(" ")),
    })),
    citations: research.claims.map((claim) => {
      const source = research.sources.find((s) => s.url === claim.sourceUrl);
      return {
        claim: claim.claim,
        source: source ? `${source.publisher} — ${source.title}` : "",
        url: claim.sourceUrl,
        usedInArticle: html.includes(claim.sourceUrl),
      };
    }),
    links: actualLinks(article),
    qualityReport: {
      pass: qc.pass,
      defects: qc.defects,
      warnings: qc.warnings,
      repairRounds,
      ...qc.computed,
    },
    research: {
      ran: research.searched,
      sourcesVerified: research.sources.length,
      claimsBound: research.claims.length,
      externalLinkBudget,
      budgetNote:
        externalLinkBudget === brief.externalLinkCount
          ? undefined
          : `Asked for ${brief.externalLinkCount} external link(s); the search produced ${research.sources.length} distinct source(s), so the piece was written to that budget rather than to an invented citation.`,
      sources: research.sources,
    },
    faq: article.faq,
    imageBriefs: article.imageBriefs,
    structuredData: buildJsonLd(brief, article),
    editorialProfile: { key: profile.key, name: profile.name },
    billing: {
      keySource,
      note:
        keySource === "workspace"
          ? "Billed to this workspace's own Anthropic key."
          : "Billed to the platform Anthropic key, which this workspace is explicitly allowed to use.",
    },
    writerNotes: article.qcNotes,
    stages,
    cmsTarget: brief.cmsTarget,
    generatedAt: new Date().toISOString(),
  };

  // The guard the old handler did not have. An empty body used to arrive at
  // AWAITING_APPROVAL and ask someone to approve nothing.
  if (!article.title || html.trim() === "") {
    throw new AgentInputError(
      "The pipeline finished without an article body, so nothing was submitted for approval.",
      "This usually means the brief was too thin for the writer to work from. Re-run with a more specific topic brief.",
      "empty_article",
    );
  }

  if (brief.requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
    return { output, costUsd };
  }

  const published = await publishToCms(run.agentConfig.workspaceId, brief.cmsTarget, article, html);
  if (published) output.cmsPublish = published;

  return { output, costUsd };
};

/** Map a form label like "Technical practitioner" back to its preset key. */
function presetKeyFromLabel(label: string): string {
  return EDITORIAL_PRESETS.find((p) => p.name === label)?.key ?? NEUTRAL_PROFILE.key;
}

/**
 * When Payload CMS is connected for this workspace, pick a few of its
 * published posts that overlap the brief's topic and add them to
 * brief.internalLinks — additive only, never dropping what the person typed
 * into Internal Links to Include. See lib/integrations/payload.ts for the
 * ranking and lib/content/qc.ts for why every link added here must actually
 * make it into the article.
 */
async function augmentInternalLinksFromPayload(
  workspaceId: string,
  brief: ContentBrief,
  report: (stage: string, detail: string) => Promise<void>,
): Promise<ContentBrief> {
  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: "PAYLOAD" } },
  });
  if (!integration) return brief;

  try {
    const creds = await decryptCredentials<PayloadCredentials>(integration.encryptedCredentials);
    const posts = await listPublishedPosts(creds, 150);
    const candidates = rankInternalLinkCandidates(
      {
        targetKeyword: brief.targetKeyword,
        secondaryKeywords: brief.secondaryKeywords,
        topicBrief: brief.topicBrief,
        workingTitle: brief.workingTitle,
      },
      posts,
      brief.internalLinks.map((l) => l.url),
      3,
    );
    if (candidates.length === 0) return brief;
    await report("internal-links", `Added ${candidates.length} internal link candidate(s) from the connected Payload CMS.`);
    return { ...brief, internalLinks: [...brief.internalLinks, ...candidates.map((c) => ({ url: c.url }))] };
  } catch (err) {
    // Best effort: the brief's own typed internal links still work. This is
    // an augmentation, not the run's purpose — a Payload hiccup should not
    // fail a blog post that has nothing else wrong with it.
    await report("internal-links", `Could not read posts from Payload: ${err instanceof Error ? err.message : String(err)}. Continuing with the internal links typed into the brief.`);
    return brief;
  }
}

/**
 * The JSON-LD a CMS should emit for this piece. Built from the article that was
 * actually written, never from the brief — a schema block that describes an FAQ
 * the page does not have is a structured-data error, not a bonus.
 */
function buildJsonLd(brief: ContentBrief, article: Article): Record<string, unknown>[] {
  const graph: Record<string, unknown>[] = [
    {
      "@context": "https://schema.org",
      "@type": brief.schemaType || "Article",
      headline: article.title,
      description: article.metaDescription,
      keywords: [brief.targetKeyword, ...brief.secondaryKeywords].filter(Boolean).join(", "),
      wordCount: article.wordCount,
      inLanguage: brief.profile.language.startsWith("US") ? "en-US" : "en",
      ...(brief.brandName ? { publisher: { "@type": "Organization", name: brief.brandName } } : {}),
    },
  ];

  if (article.faq.length > 0) {
    graph.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: article.faq.map((entry) => ({
        "@type": "Question",
        name: entry.question,
        acceptedAnswer: { "@type": "Answer", text: entry.answer },
      })),
    });
  }

  return graph;
}

/**
 * Push the draft to the workspace's CMS when approval is not required.
 *
 * Always as a draft, never live: the agent writes, a person publishes. A failure
 * here is reported on the run rather than swallowed — the old handler caught and
 * discarded every CMS error, so a wrong application password looked exactly like
 * a workspace with no integration.
 */
async function publishToCms(
  workspaceId: string,
  cmsTarget: string,
  article: Article,
  html: string,
): Promise<Record<string, unknown> | null> {
  if (cmsTarget === "None (draft only)") return null;

  const provider = cmsTarget.toUpperCase();
  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: provider as never } },
  });

  if (!integration) {
    return {
      source: "skipped",
      cmsTarget,
      reason: `No ${cmsTarget} integration is connected for this workspace. The draft is on the run and nothing was published.`,
    };
  }

  try {
    switch (cmsTarget) {
      case "WordPress":
        return await publishWordPress(integration.encryptedCredentials, article, html);
      case "Storyblok":
        return await publishStoryblok(integration.encryptedCredentials, article, html);
      case "Webflow":
        return await publishWebflow(integration.encryptedCredentials, article, html);
      case "Payload":
        return await publishPayload(integration.encryptedCredentials, article, html);
      default:
        return { source: "skipped", cmsTarget, reason: `Unknown CMS target "${cmsTarget}".` };
    }
  } catch (err) {
    return {
      source: "failed",
      cmsTarget,
      reason: err instanceof Error ? err.message : String(err),
      hint: "The article is complete and stored on this run. Fix the integration under Settings and publish it with the On-site Publisher agent.",
    };
  }
}

async function publishWordPress(encrypted: string, article: Article, html: string) {
  const creds = await decryptCredentials<{
    siteUrl: string;
    username: string;
    applicationPassword: string;
  }>(encrypted);

  const resp = await fetch(`${creds.siteUrl.replace(/\/+$/, "")}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${creds.username}:${creds.applicationPassword}`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: article.title,
      slug: article.slug,
      content: html,
      excerpt: article.metaDescription,
      status: "draft",
      meta: {
        _yoast_wpseo_title: article.title,
        _yoast_wpseo_metadesc: article.metaDescription,
        _yoast_wpseo_focuskw: article.focusKeyword,
      },
    }),
  });
  if (!resp.ok) throw new Error(`WordPress API ${resp.status}: ${await resp.text()}`);

  const result = (await resp.json()) as { id: number; link: string; status: string };
  return {
    source: "live",
    cmsTarget: "WordPress",
    publishStatus: result.status,
    postId: String(result.id),
    liveUrl: result.link,
    publishedAt: new Date().toISOString(),
  };
}

async function publishStoryblok(encrypted: string, article: Article, html: string) {
  const creds = await decryptCredentials<{ spaceId: string; managementToken: string }>(encrypted);

  const resp = await fetch(`https://mapi.storyblok.com/v1/spaces/${creds.spaceId}/stories/`, {
    method: "POST",
    headers: { Authorization: creds.managementToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      story: {
        name: article.title,
        slug: article.slug,
        content: {
          component: "blog_post",
          title: article.title,
          body: html,
          meta_title: article.title,
          meta_description: article.metaDescription,
        },
      },
    }),
  });
  if (!resp.ok) throw new Error(`Storyblok API ${resp.status}: ${await resp.text()}`);

  const result = (await resp.json()) as { story: { id: number } };
  return {
    source: "live",
    cmsTarget: "Storyblok",
    publishStatus: "draft",
    postId: String(result.story.id),
    liveUrl: `https://app.storyblok.com/#!/me/spaces/${creds.spaceId}/stories/0/0/${result.story.id}`,
    publishedAt: new Date().toISOString(),
  };
}

async function publishWebflow(encrypted: string, article: Article, html: string) {
  const creds = await decryptCredentials<{
    siteId: string;
    collectionId: string;
    apiToken: string;
  }>(encrypted);

  const resp = await fetch(`https://api.webflow.com/v2/collections/${creds.collectionId}/items`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      isArchived: false,
      isDraft: true,
      fieldData: {
        name: article.title,
        slug: article.slug,
        "post-body": html,
        "post-summary": article.metaDescription,
      },
    }),
  });
  if (!resp.ok) throw new Error(`Webflow API ${resp.status}: ${await resp.text()}`);

  const result = (await resp.json()) as { id: string };
  return {
    source: "live",
    cmsTarget: "Webflow",
    publishStatus: "draft",
    postId: result.id,
    liveUrl: `https://webflow.com/design/${creds.siteId}`,
    publishedAt: new Date().toISOString(),
  };
}

async function publishPayload(encrypted: string, article: Article, html: string) {
  const creds = await decryptCredentials<PayloadCredentials>(encrypted);

  // Lexical body fields aren't supported — there is no HTML→Lexical converter
  // here. Fail loudly rather than write a body that silently doesn't render.
  if (creds.bodyFormat === "lexical") {
    throw new Error(
      "this connection's Body format is set to Lexical — automatic HTML→Lexical conversion isn't implemented, so nothing was sent. Switch Body format to html under Settings → Integrations → Payload CMS, or publish manually.",
    );
  }

  await assertPublicUrl(creds.baseUrl);
  const resp = await fetch(`${creds.baseUrl}/api/${creds.postsCollection}`, {
    method: "POST",
    redirect: "error",
    headers: { ...payloadHeaders(creds), "Content-Type": "application/json" },
    body: JSON.stringify({
      title: article.title,
      slug: article.slug,
      [creds.bodyField]: html,
      excerpt: article.metaDescription,
      _status: "draft",
      ...(creds.tenantId ? { tenant: creds.tenantId } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`Payload API ${resp.status}: ${await resp.text()}`);

  const result = (await resp.json()) as { doc?: { id: string | number }; id?: string | number };
  const id = result.doc?.id ?? result.id;
  return {
    source: "live",
    cmsTarget: "Payload",
    publishStatus: "draft",
    postId: id != null ? String(id) : "unknown",
    liveUrl: `${creds.baseUrl}/admin/collections/${creds.postsCollection}`,
    publishedAt: new Date().toISOString(),
  };
}
