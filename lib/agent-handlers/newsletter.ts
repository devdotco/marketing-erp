import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { createKlaviyoDraft, createMailchimpDraft, resolveEspLiveData, setMailchimpContent } from "./esp-providers";
import { completeMessage } from "@/lib/ai/messages";
import type Anthropic from "@anthropic-ai/sdk";
import { jsonFrom, toolInputFrom } from "@/lib/ai/extract";
import { AgentInputError } from "@/lib/ai/errors";
import { strictSchema } from "@/lib/content/article";
import { addReview } from "@/lib/agents/integrity";
import { withProvenance } from "@/lib/agents/provenance";
import {
  buildNewsletterHtml,
  espMergeTags,
  findInventedReporting,
  lookbackStatus,
  resolveFooterText,
  safeUrl,
  sanitizeBodyHtml,
  urlKey,
  verifyStories,
  type NewsletterStory,
} from "@/lib/agents/newsletter-html";

interface ResearchedStory {
  headline: string;
  sourceUrl: string;
  sourceName: string;
  publishedDate: string;
  facts: string[];
}
interface SubmittedStories {
  stories?: ResearchedStory[];
}

const SUBMIT_STORIES_TOOL: Anthropic.Tool = {
  name: "submit_stories",
  // Without strict the input is best-effort JSON and can arrive malformed.
  strict: true,
  description:
    "Submit the real news stories found by web search. Only stories whose URL you actually saw in a search result.",
  input_schema: strictSchema({
    type: "object",
    required: ["stories"],
    properties: {
      stories: {
        type: "array",
        items: {
          type: "object",
          required: ["headline", "sourceUrl", "sourceName", "publishedDate", "facts"],
          properties: {
            headline: { type: "string" },
            sourceUrl: { type: "string", description: "Copied verbatim from a search result." },
            sourceName: { type: "string", description: "The publication, e.g. Search Engine Land." },
            publishedDate: { type: "string", description: "YYYY-MM-DD." },
            facts: {
              type: "array",
              items: { type: "string" },
              description: "Specific facts the page states, each naming who reported any figure.",
            },
          },
        },
      },
    },
  }),
};

/** Every URL a web_search call returned, keyed loosely, value verbatim. */
function collectSearchUrls(content: Anthropic.ContentBlock[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const block of content as unknown as Array<Record<string, unknown>>) {
    if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    for (const r of block.content as Array<Record<string, unknown>>) {
      if (r?.type === "web_search_result" && typeof r.url === "string") found.set(urlKey(r.url), r.url);
    }
  }
  return found;
}

function hostOf(url: string | null | undefined): string {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "");
  } catch {
    return "the source";
  }
}

/** The writer call's answer. Loose on purpose: every field is checked before use. */
type WrittenStory = Record<string, unknown> & { id?: unknown };
type WrittenIssue = Record<string, unknown> & { stories?: unknown };

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

  const today = new Date().toISOString().slice(0, 10);
  const tags = espMergeTags(espTarget);

  // --- Story plan. Internal highlights come from the form and are the only
  // stories allowed without a URL; the rest must be researched.
  const internalItems = internalHighlights
    .split(/\n+/)
    .map((l) => l.replace(/^[-*•\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, numberOfStories);
  const externalWanted = Math.max(0, numberOfStories - internalItems.length);

  const warnings: string[] = [];
  let costUsd = 0;
  let verified: ResearchedStory[] = [];
  const returnedUrls = new Map<string, string>();
  let searched = false;

  if (externalWanted > 0) {
    searched = true;
    const topic = [issueTheme, businessProfile?.industry, businessProfile?.targetAudience]
      .filter(Boolean)
      .join(" / ");
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [
          `Find ${externalWanted} real news stories for "${newsletterName}", a ${cadence.toLowerCase()} newsletter.`,
          topic ? `Audience and topic: ${topic}` : "",
          brandContext ? `Client context:\n${brandContext}` : "",
          `Today is ${today}. Only stories published in the last ${lookbackWindowDays} days (on or after ${new Date(Date.now() - lookbackWindowDays * 86_400_000).toISOString().slice(0, 10)}).`,
          "Use web_search. Prefer primary sources and reputable trade or national publications. Never a homepage, a category index, a press-release aggregator or Wikipedia.",
          "Then call submit_stories. Copy every sourceUrl verbatim from a search result: never reconstruct one from memory and never include a page you did not see returned. For each story list only the specific facts the page actually states (figures with who reported them). If you cannot find enough real stories, submit fewer rather than inventing any.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ];
    const system =
      "You are a news researcher for a newsletter. You verify before you assert. A story you did not actually see in a search result does not exist.";

    let submitted: SubmittedStories | undefined;
    for (let round = 0; round < 4 && !submitted; round++) {
      const res = await completeMessage(client, {
        model: MODELS.standard,
        // Search result blocks are billed as output, so this covers searching too.
        max_tokens: 24000,
        system,
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: 8 } as Anthropic.WebSearchTool20250305,
          SUBMIT_STORIES_TOOL,
        ],
        messages,
      });
      costUsd += estimateCostUsd(MODELS.standard, res.usage);
      for (const [key, url] of collectSearchUrls(res.content)) returnedUrls.set(key, url);
      submitted = toolInputFrom<SubmittedStories>(res, "submit_stories");
      if (submitted) break;
      messages.push({ role: "assistant", content: res.content });
      // pause_turn: the server tool needs another turn; send the assistant content back as is.
      if (res.stop_reason !== "pause_turn") {
        messages.push({
          role: "user",
          content:
            "Call submit_stories now, with sourceUrl copied exactly as it appeared in a search result. If the searches found nothing usable, call it with an empty stories array. Do not answer in prose.",
        });
      }
    }

    if (returnedUrls.size === 0) {
      throw new AgentInputError(
        "Web search returned no results, so there are no real stories to put in this issue.",
        "Widen the lookback window or loosen the issue theme and run again. The newsletter will not invent stories.",
        "no_news_found",
      );
    }

    const candidates = Array.isArray(submitted?.stories) ? submitted!.stories : [];
    const check = verifyStories(
      candidates.filter((c) => c && typeof c.headline === "string" && c.headline.trim() !== ""),
      returnedUrls.values(),
    );
    warnings.push(...check.warnings);
    for (const c of check.kept) {
      const status = lookbackStatus(c.publishedDate, lookbackWindowDays);
      if (status === "older") {
        warnings.push(`Dropped "${c.headline}": published ${c.publishedDate}, outside the ${lookbackWindowDays}-day lookback window.`);
        continue;
      }
      if (status === "unknown") warnings.push(`"${c.headline}" has no readable publication date; check it falls inside the lookback window.`);
      verified.push(c);
    }
    verified = verified.slice(0, externalWanted);

    if (verified.length === 0) {
      throw new AgentInputError(
        "Web search ran, but none of the stories it found could be verified against a returned source URL within the lookback window.",
        "Widen the lookback window or loosen the issue theme and run again. The newsletter will not invent stories.",
        "no_verified_news",
      );
    }
  }

  type Seed = {
    id: string;
    internal: boolean;
    headline: string;
    facts: string[];
    sourceUrl: string | null;
    sourceName?: string;
    publishedDate?: string;
  };
  const seeds: Seed[] = [
    ...internalItems.map((text, i): Seed => ({ id: `i${i + 1}`, internal: true, headline: text.slice(0, 120), facts: [text], sourceUrl: null })),
    ...verified.map((v, i): Seed => ({
      id: `e${i + 1}`,
      internal: false,
      headline: v.headline,
      facts: Array.isArray(v.facts) ? v.facts.map(String) : [],
      sourceUrl: v.sourceUrl ?? null,
      sourceName: v.sourceName || hostOf(v.sourceUrl),
      publishedDate: v.publishedDate,
    })),
  ];
  if (seeds.length < numberOfStories) {
    warnings.push(`Only ${seeds.length} of the ${numberOfStories} requested stories survived verification; the issue has ${seeds.length}.`);
  }
  const n = seeds.length;

  // --- Write the issue from the verified stories only; the count is known, so
  // the editorial note is written after, and about, exactly these stories.
  const systemPrompt = [
    "You are a senior newsletter editor with a strong editorial voice and a through-line.",
    "You write for engaged readers who value insight over information dumping.",
    "You report only what the supplied stories say. You did no interviews and have no inside sources.",
    "Return ONLY valid JSON: no markdown fences, no preamble, no trailing commentary.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = [
    `Write a complete ${cadence.toLowerCase()} issue of "${newsletterName}" from exactly these ${n} stories, in this order. Use no others.`,
    issueTheme ? `Issue theme: ${issueTheme}` : "",
    "",
    "STORIES (the only facts you may assert):",
    JSON.stringify(
      seeds.map((s) => ({ id: s.id, internal: s.internal, headline: s.headline, source: s.sourceName ?? "us (internal announcement)", published: s.publishedDate ?? null, facts: s.facts })),
      null,
      2,
    ),
    ctaText ? `Primary CTA for this issue: ${ctaText}` : "",
    `Write ${subjectLineVariants} distinct subject line variant(s) for A/B testing; subjectLine is the one you recommend and must also appear in subjectLineVariants.`,
    liveContext
      ? `\nReal ESP performance data. Use it for subject line style, and base recommendedSendTime on when these campaigns performed:\n${liveContext}`
      : "\nNo email platform data is available: recommendedSendTime is a general default, and its rationale says so.",
    "",
    "Hard rules:",
    "- No invented interviews, quotes, surveys or first-hand reporting. Never write \"we spoke with\", \"marketers told us\", \"advertisers who got early access\" or similar.",
    "- Every statistic or figure sits in a sentence that names who reported it (\"according to <source>\"). If a figure is not in a story's facts, do not use it.",
    "- Subject lines are 50 characters or fewer and claim only what a sourced story supports. State unverified claims as reported (\"X says\"), never as fact.",
    "- Practical advice is conditional on the reported facts (\"if your account uses X, consider Y\"), never a guarantee.",
    "- No false urgency: no \"window is closing\", \"act now\", or deadlines that a story does not state.",
    `- The editorial note is 2 short paragraphs, written knowing the issue has exactly ${n} stor${n === 1 ? "y" : "ies"}; if it counts them, the count is ${n}.`,
    "- Each story body is 2 to 4 short paragraphs of HTML using only <p>, <a href>, <strong>, <em>, <ul>, <ol>, <li>. Do not put the source link in the body; it is added for you. Internal stories use their facts as given and add nothing.",
    "- The footer is one line with the newsletter name and the placeholder [[UNSUBSCRIBE_URL]].",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      subjectLine: "At most 50 characters",
      subjectLineVariants: ["Subject line variant"],
      previewText: "Inbox preview, 90 characters max",
      fromName: newsletterName,
      editorialNote: "Editor's note",
      stories: [{ id: "e1", headline: "Story headline", summary: "One sentence", body: "<p>Story body</p>" }],
      cta: { headline: "CTA headline", body: "1 to 2 sentences", buttonText: "Button label" },
      footer: `${newsletterName}. Unsubscribe: [[UNSUBSCRIBE_URL]]`,
      recommendedSendTime: { day: "Tuesday", timeLocal: "10:00", rationale: "Why" },
    }),
  ]
    .filter(Boolean)
    .join("\n");

  const message = await completeMessage(client, {
    model: MODELS.standard,
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  costUsd += estimateCostUsd(MODELS.standard, message.usage);

  const rawText = textFrom(message);
  const written = jsonFrom<WrittenIssue>(rawText);
  if (!written || typeof written !== "object" || !Array.isArray(written.stories)) {
    throw new Error("The newsletter writer did not return a readable issue. Run it again.");
  }

  const writtenById = new Map<string, WrittenStory>();
  for (const w of written.stories as WrittenStory[]) if (w && typeof w.id === "string") writtenById.set(w.id, w);
  const stories: NewsletterStory[] = [];
  for (const s of seeds) {
    const w = writtenById.get(s.id);
    if (!w || typeof w.body !== "string" || !w.body.trim()) {
      warnings.push(`The writer returned no copy for "${s.headline}"; it was left out.`);
      continue;
    }
    const body = sanitizeBodyHtml(w.body);
    const words = body.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
    stories.push({
      headline: String(w.headline || s.headline),
      summary: typeof w.summary === "string" ? w.summary : "",
      body,
      sourceUrl: s.sourceUrl,
      ...(s.sourceName ? { sourceName: s.sourceName } : {}),
      ...(s.publishedDate ? { publishedDate: s.publishedDate } : {}),
      internal: s.internal,
      readTime: Math.max(1, Math.round(words / 200)),
    });
  }
  if (stories.length === 0) throw new Error("The newsletter writer returned no usable story copy. Run it again.");

  const str1 = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
  const subjectLine = str1(written.subjectLine).trim();
  const variants = Array.isArray(written.subjectLineVariants)
    ? (written.subjectLineVariants as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  for (const sl of new Set([subjectLine, ...variants])) {
    if (sl.length > 60) warnings.push(`Subject line is ${sl.length} characters and will truncate on mobile: "${sl}"`);
  }

  const editorialNote = str1(written.editorialNote);
  const cta = (written.cta && typeof written.cta === "object" ? written.cta : {}) as Record<string, unknown>;
  const websiteUrl = businessProfile?.websiteUrl ? safeUrl(businessProfile.websiteUrl) : null;
  const ctaUrl = websiteUrl ?? "[[CTA_URL]]";
  if (!websiteUrl) warnings.push("The CTA button has no destination: set a website URL in the Business Profile, or replace [[CTA_URL]] in your ESP.");
  const footer = resolveFooterText(str1(written.footer, `${newsletterName}. [[UNSUBSCRIBE_URL]]`), espTarget);

  const invented = findInventedReporting(
    [editorialNote, subjectLine, ...stories.map((s) => `${s.headline} ${s.body.replace(/<[^>]+>/g, " ")}`)].join("\n"),
  );
  if (invented) warnings.push(`Possible invented reporting ("${invented}"): the agent did no interviews. Remove it before sending.`);

  const send = (written.recommendedSendTime && typeof written.recommendedSendTime === "object" ? written.recommendedSendTime : {}) as Record<string, unknown>;
  const fromEsp = source === "live";
  const recommendedSendTime = {
    day: str1(send.day, "Tuesday"),
    timeLocal: str1(send.timeLocal, "10:00"),
    rationale: fromEsp
      ? str1(send.rationale, "Based on recent campaign performance.")
      : "General default, not based on your send data: connect Mailchimp or Klaviyo for a data-based time.",
    basis: fromEsp ? "esp_data" : "general_default",
  };

  const words = (t: string) => t.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
  const wordCount = words(editorialNote) + stories.reduce((a, s) => a + words(s.body), 0) + words(str1(cta.body));
  const issueNumberRaw = num(config, "issueNumber", 0, { min: 0 });
  const issueNumber = issueNumberRaw >= 1 ? Math.floor(issueNumberRaw) : null;

  const html = buildNewsletterHtml({
    newsletterName,
    issueNumber,
    previewText: str1(written.previewText),
    editorialNote,
    stories,
    cta: { headline: str1(cta.headline), body: str1(cta.body), buttonText: str1(cta.buttonText), url: ctaUrl },
    footer: str1(written.footer, `${newsletterName}. [[UNSUBSCRIBE_URL]]`),
    espTarget,
  });

  const output: Record<string, unknown> = {
    issueNumber,
    subjectLine,
    subjectLineVariants: variants.length ? variants : [subjectLine],
    previewText: str1(written.previewText),
    fromName: str1(written.fromName, newsletterName),
    editorialNote,
    storyCount: stories.length,
    stories,
    sponsorSlot: null,
    cta: { headline: str1(cta.headline), body: str1(cta.body), buttonText: str1(cta.buttonText), url: ctaUrl },
    footer,
    mergeTags: tags,
    recommendedSendTime,
    html,
    espTarget,
    wordCount,
  };

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
      if (draftId && typeof output.html === "string") {
        try {
          await setMailchimpContent(mailchimpCreds.apiKey, mailchimpCreds.server, draftId, output.html);
        } catch (err) {
          output.espDraftError = `Mailchimp draft created but its content could not be set: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
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

  // "live" now means the news was really searched; the ESP only informs subject
  // lines and send time and is reported separately.
  output.source = searched ? (returnedUrls.size > 0 ? "live" : "simulation") : source;
  output.espSource = source;
  if (espReadError) output.espReadError = espReadError;
  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  addReview(output, { warnings });
  withProvenance(
    output,
    "newsletter",
    [
      ...(searched ? [{ source: "WEB_SEARCH" as const, detail: `${returnedUrls.size} results, last ${lookbackWindowDays} days`, rows: returnedUrls.size }] : []),
      ...(source === "live" && espProvider ? [{ source: "ESP" as const, detail: `${espProvider === "MAILCHIMP" ? "Mailchimp" : "Klaviyo"} recent campaigns` }] : []),
    ],
    searched ? "Stories were found by live web search; each external story links to a URL the search returned." : undefined,
  );

  return { output, costUsd };
};
