import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { createKlaviyoDraft, createMailchimpDraft, resolveEspLiveData } from "./esp-providers";

export const newsletterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  const newsletterName =
    typeof config.newsletterName === "string" ? config.newsletterName : "The Newsletter";
  // Renamed to the Run form's keys on 2026-09-14; the old names still work from a saved config.
  applyRenamedInputs(run, config, { issueFrequency: "cadence", maxItemsPerIssue: "numberOfStories" });
  const cadence = str(config, "issueFrequency", "Monthly");
  const issueTheme = str(config, "issueTheme");
  const numberOfStories = num(config, "maxItemsPerIssue", 6, { min: 1, max: 12 });
  const ctaText = str(config, "cta");
  const lookbackWindowDays = num(config, "lookbackWindowDays", 30, { min: 1, max: 365 });
  const internalHighlights = str(config, "internalHighlights");
  const subjectLineVariants = num(config, "subjectLineVariants", 3, { min: 1, max: 5 });
  const espTarget =
    typeof config.espTarget === "string" ? config.espTarget : "Draft";

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandVoiceStr =
    businessProfile?.brandVoice != null
      ? String(businessProfile.brandVoice)
      : "";

  const goalsStr =
    businessProfile?.goals != null
      ? String(businessProfile.goals)
      : "";

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        brandVoiceStr ? `Brand voice: ${brandVoiceStr}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        goalsStr ? `Business goals: ${goalsStr}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  // --- Live ESP data: Mailchimp → Klaviyo. A connected-but-broken ESP doesn't
  // silently look identical to no ESP — see esp-providers.ts.
  const espResult = await resolveEspLiveData(run.agentConfig.workspaceId, 5);
  const liveContext = espResult.source === "live" ? espResult.liveContext : "";
  const source = espResult.source;
  const espProvider = espResult.source === "live" ? espResult.provider : null;
  const mailchimpCreds = espResult.source === "live" && espResult.provider === "MAILCHIMP" ? espResult.mailchimpCreds : null;
  const klaviyoCreds = espResult.source === "live" && espResult.provider === "KLAVIYO" ? espResult.klaviyoCreds : null;
  const mailchimpAudienceId = espResult.source === "live" && espResult.provider === "MAILCHIMP" ? espResult.mailchimpAudienceId : "";
  const espReadError = espResult.source === "simulation" ? espResult.error : undefined;

  const systemPrompt = [
    "You are a senior newsletter editor who writes with a strong editorial voice and through-line.",
    "Each issue has a unifying theme that ties all stories together — rather than being a disconnected list of links.",
    "Your editorial notes feel personal and human, as if written by a trusted expert sharing their genuine perspective.",
    "You write for engaged readers who value insight over information dumping.",
    "Stories have real narrative structure: a tension, a development, and a takeaway.",
    "Subject lines are specific and curiosity-driven — never clickbait, always true.",
    "Return ONLY valid JSON — no markdown fences, no preamble, no trailing commentary.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const espFormatNote: Record<string, string> = {
    Mailchimp: "Format body fields as standard HTML compatible with Mailchimp's template builder.",
    Klaviyo: "Format body fields as HTML compatible with Klaviyo's drag-and-drop editor blocks.",
    Beehiiv: "Format body fields as clean prose HTML — Beehiiv renders from its own editor.",
    Draft: "Format body fields as clean, readable HTML suitable for any ESP.",
  };
  const espNote = espFormatNote[espTarget] ?? espFormatNote["Draft"];

  const userPrompt = [
    `Write a complete ${cadence.toLowerCase()} issue of "${newsletterName}".`,
    issueTheme ? `Issue theme: ${issueTheme}` : "",
    `Include exactly ${numberOfStories} stories, each connected by the editorial through-line of the issue theme.`,
    `Cover developments from the last ${lookbackWindowDays} days only (today is ${new Date().toISOString().slice(0, 10)}) — nothing older.`,
    internalHighlights
      ? `\nInternal highlights to feature in this issue (announcements, product updates, events — use these facts as given, and count each as one of the stories):\n${internalHighlights}`
      : "",
    ctaText ? `Primary CTA for this issue: ${ctaText}` : "",
    `Write ${subjectLineVariants} distinct subject line variant(s) for A/B testing; subjectLine is the one you recommend and must also appear in subjectLineVariants.`,
    espNote,
    liveContext
      ? `\nReal ESP performance data — use these past campaign results to inform your subject line style, story angles, and content tone:\n${liveContext}`
      : "",
    "",
    "Requirements:",
    "- The editorial note should reference the theme personally and set up why it matters right now.",
    "- Each story must have a full body (3–5 paragraphs), not just a summary sentence.",
    "- Read time should be calculated at 200 words per minute.",
    "- sourceUrl should be a plausible URL if no real URL is known (mark as null if invented).",
    "- The footer should include an unsubscribe placeholder and the newsletter name.",
    "- wordCount is the total word count of all body text combined (editorial note + all story bodies + cta body).",
    "- issueNumber and sponsorSlot should be null — these are filled in by the platform.",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      issueNumber: null,
      subjectLine: "Specific, curiosity-driven subject line",
      subjectLineVariants: ["Subject line variant"],
      previewText: "Preview text shown in inbox — 90 characters max",
      fromName: newsletterName,
      editorialNote:
        "Personal 2–3 paragraph editor's note that frames the issue theme and sets up the stories",
      stories: [
        {
          headline: "Story headline",
          summary: "One sentence summary (used as card subtitle in some ESPs)",
          body: "Full story body in HTML — 3 to 5 paragraphs",
          sourceUrl: "https://example.com/source-article or null",
          readTime: 3,
        },
      ],
      sponsorSlot: null,
      cta: {
        headline: "CTA section headline",
        body: "1–2 sentence CTA body copy",
        buttonText: "CTA button label",
        url: "[[CTA_URL]]",
      },
      footer:
        "Footer text with unsubscribe placeholder [[UNSUBSCRIBE_URL]] and newsletter name",
      espTarget: espTarget,
      wordCount: 0,
    }),
  ]
    .filter(Boolean)
    .join("\n");

  const message = await client.messages.create({
    model: MODELS.standard,
    max_tokens: 8096,
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

  // --- Create draft in ESP ---
  if (espProvider === "MAILCHIMP" && mailchimpCreds && mailchimpAudienceId) {
    try {
      const issueTitle =
        typeof output.subjectLine === "string"
          ? output.subjectLine
          : `${newsletterName} — New Issue`;
      const fromName =
        typeof output.fromName === "string" ? output.fromName : newsletterName;
      const hostname = businessProfile?.websiteUrl
        ? (() => {
            try {
              return new URL(businessProfile.websiteUrl).hostname;
            } catch {
              return "example.com";
            }
          })()
        : "example.com";
      const replyTo = `hello@${hostname}`;

      const draftId = await createMailchimpDraft(
        mailchimpCreds.apiKey,
        mailchimpCreds.server,
        mailchimpAudienceId,
        issueTitle,
        issueTitle,
        fromName,
        replyTo
      );
      output.espDraftId = draftId;
      output.espDraftProvider = "MAILCHIMP";
    } catch (err) {
      // Non-fatal — the issue copy above is genuine either way, but don't
      // pretend a draft exists in Mailchimp when the create call failed.
      output.espDraftError = `Mailchimp: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (espProvider === "KLAVIYO" && klaviyoCreds) {
    try {
      const issueTitle =
        typeof output.subjectLine === "string"
          ? output.subjectLine
          : `${newsletterName} — New Issue`;
      const draftId = await createKlaviyoDraft(klaviyoCreds.apiKey, issueTitle);
      output.espDraftId = draftId;
      output.espDraftProvider = "KLAVIYO";
    } catch (err) {
      output.espDraftError = `Klaviyo: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  output.source = source;
  if (espReadError) output.espReadError = espReadError;
  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};
