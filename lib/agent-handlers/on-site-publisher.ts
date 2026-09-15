import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
import { storyblokManagementBase } from "@/lib/integrations/catalog";
import { assertPublicUrl } from "@/lib/integrations/public-url";
import { payloadHeaders, type PayloadCredentials } from "@/lib/integrations/payload";

export const onSitePublisherHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);
  const cmsTarget = String(config.cmsTarget ?? "WordPress");
  const publishStatus = String(config.publishStatus ?? "Draft");
  const draftId = String(config.draftId ?? "");
  const primaryCategory = String(config.primaryCategory ?? "");
  const overwriteExisting = config.overwriteExisting === true;
  // Only meaningful with Publish Status "Scheduled". This agent still only ever
  // creates drafts: the time is stamped on the WordPress draft as its publish
  // date (WordPress schedules it for then once an editor publishes it) and
  // recorded in the output for the other CMSes — nothing goes live from here.
  const scheduledAtRaw = publishStatus === "Scheduled" ? String(config.scheduledAt ?? "").trim() : "";
  const scheduledDate = scheduledAtRaw ? new Date(scheduledAtRaw) : null;
  const scheduledAt = scheduledDate && !Number.isNaN(scheduledDate.getTime()) ? scheduledDate.toISOString() : "";
  const scheduleNote = publishStatus !== "Scheduled"
    ? undefined
    : scheduledAt
      ? cmsTarget === "WordPress"
        ? `Requested publish time ${scheduledAt} was set on the WordPress draft — publish it in WordPress to schedule it for then.`
        : `Requested publish time ${scheduledAt}. The ${cmsTarget} post was created as a draft; set this time when you schedule it in ${cmsTarget}.`
      : scheduledAtRaw
        ? `"${scheduledAtRaw}" isn't a valid ISO 8601 datetime, so no publish time was set on the draft.`
        : "Publish Status is Scheduled but no Scheduled Publish Time was given, so no publish time was set on the draft.";

  const requireApproval = config.requireApproval !== false;

  // Fetch draft content from a previous AgentRun output (e.g., blog-writer output)
  let draftContent: Record<string, unknown> = {};
  if (draftId) {
    // Scoped to this run's workspace: a Draft ID is typed by a user, and without
    // the workspace filter any operator could publish another tenant's draft by
    // pasting its run id.
    const draftRun = await prisma.agentRun.findFirst({
      where: { id: draftId, workspaceId: run.agentConfig.workspaceId },
      include: { agentConfig: { select: { agentSlug: true } } },
    });
    // Same rules the Draft dropdown applies (app/api/runs/drafts): an approved
    // Blog Writer / Content Refresh run with a body. Checked here too, because a
    // saved config or an API caller can send any id, and a missing draft used
    // to fall through and publish "Untitled Post" with no content.
    const draftOutput = draftRun?.output as Record<string, unknown> | null | undefined;
    if (
      !draftRun ||
      !["blog-writer", "content-refresh"].includes(draftRun.agentConfig.agentSlug) ||
      !["APPROVED", "COMPLETED"].includes(draftRun.status) ||
      !draftOutput ||
      typeof draftOutput.content !== "string" ||
      !draftOutput.content
    ) {
      throw new AgentInputError(
        "That draft can't be published: it isn't an approved Blog Writer or Content Refresh draft in this workspace.",
        draftRun && draftRun.status === "AWAITING_APPROVAL"
          ? "Approve the draft's run first, then pick it again."
          : "Pick an approved draft from the Draft dropdown.",
        "draft_not_publishable",
      );
    }
    draftContent = draftOutput;
  }

  const postTitle = String(draftContent.title ?? "Untitled Post");
  const postSlug = String(
    draftContent.slug ??
    postTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  );
  const postContent = String(draftContent.content ?? "");
  const postMetaDesc = String(draftContent.metaDescription ?? "");

  // Only look up (and only ever attempt) the CMS the customer actually chose
  // in cmsTarget — the old code fetched all three and tried WordPress, then
  // Storyblok, then Webflow, regardless of what was selected, so a workspace
  // with both WordPress and Storyblok connected could publish to the wrong
  // one if it wasn't first in that hardcoded order.
  const [wpIntegration, storyblokIntegration, webflowIntegration, payloadIntegration] = await Promise.all([
    cmsTarget === "WordPress"
      ? prisma.integration.findUnique({
          where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "WORDPRESS" } },
        })
      : null,
    cmsTarget === "Storyblok"
      ? prisma.integration.findUnique({
          where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "STORYBLOK" } },
        })
      : null,
    cmsTarget === "Webflow"
      ? prisma.integration.findUnique({
          where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "WEBFLOW" } },
        })
      : null,
    cmsTarget === "Payload"
      ? prisma.integration.findUnique({
          where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "PAYLOAD" } },
        })
      : null,
  ]);

  if (["WordPress", "Storyblok", "Webflow", "Payload"].includes(cmsTarget) && !wpIntegration && !storyblokIntegration && !webflowIntegration && !payloadIntegration) {
    throw new AgentInputError(
      `${cmsTarget} is selected as the CMS Target, but it isn't connected for this workspace.`,
      `Connect ${cmsTarget} under Settings → Integrations, or change the CMS Target field.`,
      "cms_not_connected",
    );
  }

  // A connected CMS that fails is not the same as no CMS connected — the old
  // behaviour swallowed every publish error and fell all the way through to a
  // Claude-simulated "status: success" with a fake postId/liveUrl, which told
  // the customer their post went live when nothing was ever sent anywhere.
  const failures: string[] = [];

  // Once a CMS has answered 2xx to the create call, the post EXISTS. Everything
  // after that — reading the body, recording the status — must never be
  // reported as "nothing published", or a retry creates a second copy. So the
  // risky part (credentials + request) is the only thing a failure can come
  // from; the body is read leniently and whatever id it yields is kept.
  async function createRemote<T>(
    cms: string,
    send: () => Promise<Response>,
  ): Promise<{ created: true; result: Partial<T> } | { created: false }> {
    let resp: Response;
    try {
      resp = await send();
    } catch (err) {
      // A network error can land after the CMS accepted the request — say so.
      failures.push(`${cms}: request did not complete (${err instanceof Error ? err.message : String(err)}) — check ${cms} for a new draft before retrying`);
      return { created: false };
    }
    if (!resp.ok) {
      failures.push(`${cms} API ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 500)}`);
      return { created: false };
    }
    const text = await resp.text().catch(() => "");
    try {
      return { created: true, result: JSON.parse(text) as Partial<T> };
    } catch {
      // Security plugins love printing a notice before the JSON. The post is real.
      const start = text.indexOf("{");
      try {
        return { created: true, result: start >= 0 ? (JSON.parse(text.slice(start)) as Partial<T>) : {} };
      } catch {
        return { created: true, result: {} };
      }
    }
  }

  async function finish(output: Record<string, unknown>) {
    if (requireApproval) {
      try {
        await updateStatus("AWAITING_APPROVAL", output);
      } catch (err) {
        throw new Error(
          `${output.cmsTarget} draft WAS created (id ${output.postId ?? "unknown"}), but recording it failed: ${err instanceof Error ? err.message : String(err)}. Do not re-run — the draft already exists.`,
        );
      }
    }
    return { output, costUsd: 0 };
  }

  const unreadable = "created — the CMS response could not be read; find it in the CMS drafts";

  // WordPress live publish
  if (wpIntegration && postContent) {
    let siteUrl = "";
    const outcome = await createRemote<{ id: number; link: string; status: string }>("WordPress", async () => {
      const creds = await decryptCredentials<{ siteUrl: string; username: string; applicationPassword: string }>(
        wpIntegration.encryptedCredentials
      );
      siteUrl = creds.siteUrl;
      await assertPublicUrl(creds.siteUrl);
      return fetch(`${creds.siteUrl}/wp-json/wp/v2/posts`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: "Basic " + btoa(`${creds.username}:${creds.applicationPassword}`),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: postTitle,
          content: postContent,
          status: "draft",
          ...(scheduledAt ? { date_gmt: scheduledAt.replace(/\.\d{3}Z$/, "") } : {}),
          categories: [],
          tags: [],
          meta: { _yoast_wpseo_title: postTitle, _yoast_wpseo_metadesc: postMetaDesc },
        }),
      });
    });
    if (outcome.created) {
      const r = outcome.result;
      return finish({
        status: "success",
        source: "live",
        cmsTarget: "WordPress",
        publishStatus: r.status ?? "draft",
        postId: r.id != null ? String(r.id) : unreadable,
        liveUrl: r.link ?? `${siteUrl}/wp-admin/edit.php?post_status=draft`,
        stagedAt: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        ...(scheduleNote ? { scheduledAt: scheduledAt || null, scheduleNote } : {}),
      });
    }
  }

  // Storyblok live publish. Management API base URL is per-region (space's
  // region never changes after creation) — see lib/integrations/catalog.ts.
  if (storyblokIntegration && postContent) {
    let spaceId = "";
    const outcome = await createRemote<{ story: { id: number; full_slug: string } }>("Storyblok", async () => {
      const creds = await decryptCredentials<{ spaceId: string; managementToken: string; region?: string }>(
        storyblokIntegration.encryptedCredentials
      );
      spaceId = creds.spaceId;
      const base = storyblokManagementBase(creds.region ?? "eu");
      return fetch(`${base}/spaces/${creds.spaceId}/stories`, {
        method: "POST",
        headers: {
          // Personal access tokens go in Authorization as-is — no "Bearer " prefix.
          Authorization: creds.managementToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          story: {
            name: postTitle,
            slug: postSlug,
            // Assumes the space has a "blog_post" component with these fields —
            // flagged to the customer in the Storyblok connect form's hint.
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
    });
    if (outcome.created) {
      const id = outcome.result.story?.id;
      return finish({
        status: "success",
        source: "live",
        cmsTarget: "Storyblok",
        publishStatus: "draft",
        postId: id != null ? String(id) : unreadable,
        liveUrl: id != null
          ? `https://app.storyblok.com/#!/me/spaces/${spaceId}/stories/0/0/${id}`
          : `https://app.storyblok.com/#!/me/spaces/${spaceId}/stories`,
        stagedAt: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        ...(scheduleNote ? { scheduledAt: scheduledAt || null, scheduleNote } : {}),
      });
    }
  }

  // Webflow live publish
  if (webflowIntegration && postContent) {
    let siteId = "";
    const outcome = await createRemote<{ id: string }>("Webflow", async () => {
      const creds = await decryptCredentials<{ siteId: string; collectionId: string; apiToken: string }>(
        webflowIntegration.encryptedCredentials
      );
      siteId = creds.siteId;
      return fetch(`https://api.webflow.com/v2/collections/${creds.collectionId}/items`, {
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
    });
    if (outcome.created) {
      return finish({
        status: "success",
        source: "live",
        cmsTarget: "Webflow",
        publishStatus: "draft",
        postId: outcome.result.id ?? unreadable,
        liveUrl: `https://webflow.com/design/${siteId}`,
        stagedAt: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        ...(scheduleNote ? { scheduledAt: scheduledAt || null, scheduleNote } : {}),
      });
    }
  }

  // Payload live publish. Creates a draft (`_status: "draft"`) — this agent
  // never publishes live, same as the other three CMSes above. Lexical body
  // fields aren't supported: there is no HTML→Lexical converter here, so a
  // connection configured for lexical fails loudly instead of writing a body
  // that silently doesn't render.
  if (payloadIntegration && postContent) {
    const payloadCreds = await decryptCredentials<PayloadCredentials>(payloadIntegration.encryptedCredentials);
    if (payloadCreds.bodyFormat === "lexical") {
      failures.push(
        "Payload: this connection's Body format is set to Lexical — automatic HTML→Lexical conversion isn't implemented, so nothing was sent. Switch Body format to html under Settings → Integrations → Payload CMS (the field must accept raw HTML), or publish manually.",
      );
    } else {
      let liveUrl = "";
      const outcome = await createRemote<{ doc?: { id: string | number }; id?: string | number }>("Payload", async () => {
        const creds = payloadCreds;
        await assertPublicUrl(creds.baseUrl);
        liveUrl = `${creds.baseUrl}/admin/collections/${creds.postsCollection}`;
        return fetch(`${creds.baseUrl}/api/${creds.postsCollection}`, {
          method: "POST",
          redirect: "error",
          headers: {
            ...payloadHeaders(creds),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: postTitle,
            slug: postSlug,
            [creds.bodyField]: postContent,
            excerpt: postMetaDesc,
            _status: "draft",
            ...(creds.tenantId ? { tenant: creds.tenantId } : {}),
          }),
        });
      });
      if (outcome.created) {
        const id = outcome.result.doc?.id ?? outcome.result.id;
        return finish({
          status: "success",
          source: "live",
          cmsTarget: "Payload",
          publishStatus: "draft",
          postId: id != null ? String(id) : unreadable,
          liveUrl,
          stagedAt: new Date().toISOString(),
          generatedAt: new Date().toISOString(),
          ...(scheduleNote ? { scheduledAt: scheduledAt || null, scheduleNote } : {}),
        });
      }
    }
  }

  // A CMS is connected but the create call on it failed — fail loudly rather
  // than hand back a fabricated "success". Only reachable when WordPress,
  // Storyblok, Webflow or Payload has stored credentials for this workspace.
  if (failures.length > 0) {
    throw new AgentInputError(
      `Publishing to ${cmsTarget} failed: ${failures.join("; ")}`,
      "Check the credentials under Settings → Integrations for the CMS above — a stale token, wrong site/space ID, or a disabled REST API are the usual causes.",
      "cms_publish_failed",
    );
  }
  if ((wpIntegration || storyblokIntegration || webflowIntegration || payloadIntegration) && !postContent) {
    throw new AgentInputError(
      "A CMS integration is connected, but there's no draft content to publish.",
      "Run this after an agent that produces a draft (e.g. Blog Writer), and pass its run as Draft ID — or approve a pending draft first.",
      "no_draft_content",
    );
  }

  // ── Claude simulation fallback ─────────────────────────────────────────────
  // Reached only when no CMS is connected at all.
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
    scheduledAt ? `Scheduled publish time: ${scheduledAt}` : "",
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
    model: MODELS.fast,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.source = "simulation";
  if (scheduleNote) {
    output.scheduledAt = scheduledAt || null;
    output.scheduleNote = scheduleNote;
  }
  output.generatedAt = new Date().toISOString();
  output.note = "Simulated publish — connect a live CMS integration in Settings to enable real deployment.";

  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
