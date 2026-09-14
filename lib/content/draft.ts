import type Anthropic from "@anthropic-ai/sdk";
import { assertNotTruncated } from "@/lib/ai/extract";
import { createMessage } from "@/lib/ai/messages";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import {
  hasArticleBody,
  normaliseArticle,
  renderMarkdown,
  submittedFields,
  SUBMIT_ARTICLE_TOOL,
  SUBMIT_ARTICLE_TOOL_NAME,
  type Article,
  type SubmittedArticle,
} from "./article";
import { buildSystemPrompt, renderLengthInstruction, type ContentBrief } from "./brief";
import { renderResearch, type ResearchResult } from "./research";
import { domainList } from "./domains";

export interface DraftResult {
  article: Article;
  costUsd: number;
  rounds: number;
}

/**
 * Output budget, sized off the brief.
 *
 * Three things share this budget and only one of them is the article. The model
 * thinks before a long-form answer (3k tokens is ordinary), every web_search
 * result block comes back inside the response, and the article itself costs
 * roughly 3x its word count once runs, headings and link fields are counted. A
 * 1100-word draft truncated at 15k on the first live run for exactly that
 * reason. Truncation is not a soft failure either: the tool call arrives missing
 * its trailing fields and reads downstream as a malformed article.
 *
 * Sonnet 5 accepts well over 64k here, so the ceiling is ours, not the model's.
 */
function maxTokensFor(words: number): number {
  return Math.min(64000, Math.max(20000, Math.round(words * 24)));
}

function webSearchTool(brief: ContentBrief): Anthropic.WebSearchTool20250305 {
  const tool: Anthropic.WebSearchTool20250305 = {
    type: "web_search_20250305",
    name: "web_search",
    // The research pass already did the finding. This is for the occasional
    // extra reference the draft needs, and every result block it returns is
    // charged against the same output budget the article has to fit in.
    max_uses: 3,
  };
  // Same two rules as the research pass: the filters are mutually exclusive, and
  // neither may repeat a domain. See domainList.
  if (brief.preferredSources.length > 0) {
    tool.allowed_domains = domainList(brief.preferredSources);
  } else if (brief.blockedDomains.length > 0) {
    tool.blocked_domains = domainList(brief.blockedDomains);
  }
  return tool;
}

function findSubmission(message: Anthropic.Message): Anthropic.ToolUseBlock | undefined {
  return message.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === "tool_use" && block.name === SUBMIT_ARTICLE_TOOL_NAME,
  );
}

/**
 * Run the writer to a complete submit_article call.
 *
 * The corrective round is the point of this function. A submission can arrive
 * structurally valid and empty — after a web_search round the model sometimes
 * "submits" with only the leading fields and no sections, with a perfectly
 * normal stop_reason. dm-watcher accepted one of those and the failure surfaced
 * hundreds of lines later blaming max_tokens, which was never the cause.
 */
async function runWriter(
  client: Anthropic,
  system: Anthropic.TextBlockParam[],
  userPrompt: string,
  brief: ContentBrief,
  maxTokens: number,
  allowSearch: boolean,
): Promise<{ submitted: SubmittedArticle; costUsd: number; rounds: number }> {
  const tools: Anthropic.ToolUnion[] = allowSearch
    ? [webSearchTool(brief), SUBMIT_ARTICLE_TOOL]
    : [SUBMIT_ARTICLE_TOOL];

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];

  const first = await createMessage(client, {
    model: MODELS.standard,
    max_tokens: maxTokens,
    system,
    tools,
    // Forcing the tool would block web_search, so with search on the model picks.
    tool_choice: allowSearch ? { type: "auto" } : { type: "tool", name: SUBMIT_ARTICLE_TOOL_NAME },
    messages,
  });

  let costUsd = estimateCostUsd(MODELS.standard, first.usage);
  const firstSubmission = findSubmission(first);

  if (firstSubmission && hasArticleBody(firstSubmission.input as SubmittedArticle)) {
    assertNotTruncated(first, "The article draft");
    return { submitted: firstSubmission.input as SubmittedArticle, costUsd, rounds: 1 };
  }

  assertNotTruncated(first, "The article draft");

  // Second round. Replaying an assistant turn that contains a tool_use means the
  // next user message MUST open with a matching tool_result, or the API rejects
  // the request with "tool_use ids were found without tool_result blocks
  // immediately after".
  const followUp: Anthropic.ContentBlockParam[] = [];
  if (firstSubmission) {
    followUp.push({
      type: "tool_result",
      tool_use_id: firstSubmission.id,
      is_error: true,
      content: `That submission had no article body. Fields received: ${submittedFields(firstSubmission.input)}.`,
    });
  }
  followUp.push({
    type: "text",
    text: firstSubmission
      ? "The article was not submitted: sections was empty. Call submit_article again now with the COMPLETE article — intro_blocks populated, and every body section with its heading and its blocks. Do not search again; write it from what you already have."
      : "You did not call submit_article. Call it now with the complete article: intro_blocks populated, and every body section with its heading and its blocks.",
  });

  messages.push({ role: "assistant", content: first.content });
  messages.push({ role: "user", content: followUp });

  const second = await createMessage(client, {
    model: MODELS.standard,
    max_tokens: maxTokens,
    system,
    tools: [SUBMIT_ARTICLE_TOOL],
    tool_choice: { type: "tool", name: SUBMIT_ARTICLE_TOOL_NAME },
    messages,
  });

  costUsd += estimateCostUsd(MODELS.standard, second.usage);
  assertNotTruncated(second, "The article draft");

  const secondSubmission = findSubmission(second);
  if (!secondSubmission || !hasArticleBody(secondSubmission.input as SubmittedArticle)) {
    throw new Error(
      `The writer never returned an article body. Last submission carried: ${submittedFields(secondSubmission?.input)}.`,
    );
  }

  return { submitted: secondSubmission.input as SubmittedArticle, costUsd, rounds: 2 };
}

export async function draftArticle(
  client: Anthropic,
  brief: ContentBrief,
  research: ResearchResult,
): Promise<DraftResult> {
  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: buildSystemPrompt(brief),
      // The voice spec is byte-identical for every article in a workspace and is
      // read again by each repair round, so it is worth an hour-long breakpoint.
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];

  const prompt = [
    `CONTENT TYPE: ${brief.contentType}. Write it the way that format is actually read.`,
    brief.workingTitle
      ? `WORKING TITLE (a direction, not a mandate — improve on it if you can): ${brief.workingTitle}`
      : "",
    `TOPIC BRIEF\n${brief.topicBrief}`,
    brief.targetKeyword
      ? `PRIMARY KEYWORD: "${brief.targetKeyword}". Use it naturally in the title, in the first 100 words, and in two or three subheadings. Never force it, and never repeat it into a keyword pile-up.`
      : "",
    brief.secondaryKeywords.length > 0
      ? `SECONDARY KEYWORDS — work these in where they genuinely fit:\n- ${brief.secondaryKeywords.join("\n- ")}`
      : "",
    brief.searchIntent && !brief.searchIntent.startsWith("Auto")
      ? `SEARCH INTENT: ${brief.searchIntent}. Answer what a reader with that intent actually wants, in the shape they want it.`
      : "",
    `FUNNEL STAGE: ${brief.funnelStage}. Someone at this stage has a specific amount of context and a specific next question — meet them there rather than selling past them.`,
    brief.keyQuestions.length > 0
      ? `QUESTIONS THE PIECE MUST ANSWER — each one gets a real answer somewhere in the body:\n- ${brief.keyQuestions.join("\n- ")}`
      : "",
    brief.mustCover.length > 0
      ? `MUST COVER — every one of these has to appear in the finished piece:\n- ${brief.mustCover.join("\n- ")}`
      : "",
    brief.mustAvoid.length > 0
      ? `MUST NOT APPEAR — hard exclusions, in any form, including in passing:\n- ${brief.mustAvoid.join("\n- ")}`
      : "",
    "",
    brief.audienceDescription ? `READER: ${brief.audienceDescription}` : "",
    `READING LEVEL: ${brief.readingLevel}. Calibrate assumed knowledge and vocabulary to this reader, not to a general one.`,
    `TONE: ${brief.tone}`,
    brief.authorPersona
      ? `WHOSE EXPERTISE THIS REFLECTS: ${brief.authorPersona}. Write with the specificity someone in that role would actually have — the details they would know and a generalist would not. Never claim a credential or a first-hand experience you were not given.`
      : "",
    brief.brandContext ? `THE BUSINESS PUBLISHING THIS\n${brief.brandContext}` : "",
    brief.competitorUrls.length > 0
      ? `COMPETING ARTICLES — cover what these miss, and do not mirror their structure:\n- ${brief.competitorUrls.join("\n- ")}`
      : "",
    "",
    brief.opener,
    brief.shape,
    "",
    renderLengthInstruction(brief.length),
    "",
    renderResearch(research, brief),
    brief.proofPoints.length > 0
      ? `\nFIRST-PARTY EVIDENCE — the business has verified these and you may state them as its own, with no external link. Do not embellish them and do not invent siblings for them:\n- ${brief.proofPoints.join("\n- ")}`
      : "",
    "",
    renderInternalLinks(brief),
    renderPromotion(brief),
    brief.complianceNotes
      ? `COMPLIANCE CONSTRAINTS — these are hard rules and they outrank every style preference above:\n${brief.complianceNotes}`
      : "",
    "",
    renderDeliverables(brief),
    "",
    "Also return: a URL slug, and a 150-160 character meta description written for a human scanning a results page (it must not simply restate the title).",
    `Write the ${brief.contentType.toLowerCase()} now and submit it through submit_article.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { submitted, costUsd, rounds } = await runWriter(
    client,
    system,
    prompt,
    brief,
    maxTokensFor(brief.length.max),
    brief.webResearch,
  );

  return {
    article: normaliseArticle(submitted, { focusKeyword: brief.targetKeyword }),
    costUsd,
    rounds,
  };
}

/**
 * How far over the band this draft is, in words.
 *
 * "Trim to length" on its own gets a draft trimmed by forty words when it is two
 * hundred over. The number is the instruction.
 */
function overLength(article: Article, brief: ContentBrief): string {
  const over = article.wordCount - brief.length.max;
  if (over <= 0) return "";
  return `This draft is ${article.wordCount} words, which is ${over} over the ceiling. Cut AT LEAST ${over + 40} words — remove whole sections or whole paragraphs, never trim a sentence here and there, and never leave a heading with a thin body under it.`;
}

/**
 * The non-prose fields the brief asked for.
 *
 * `faq` and `image_briefs` are required fields on the tool, so the model always
 * returns them; this says what has to be in them. Both appear in the draft
 * prompt and again in every repair round.
 */
function renderDeliverables(brief: ContentBrief): string {
  return [
    brief.includeFaq
      ? "FAQ — populate the faq field with 3-5 questions a reader still has after finishing the piece. Answer each in 2-4 sentences. Do not repeat body copy verbatim, and do not answer a question the article already settles."
      : "FAQ — return an empty array for the faq field.",
    brief.includeImageBriefs
      ? "IMAGE BRIEFS — populate image_briefs with one entry per image slot: where it sits, what it should show concretely, and its alt text. Alt text describes the image for someone who cannot see it; it is not a keyword string."
      : "IMAGE BRIEFS — return an empty array for the image_briefs field.",
    brief.requiredDisclaimers.length > 0
      ? `REQUIRED DISCLAIMERS — reproduce each of these VERBATIM, once, where it belongs:\n- ${brief.requiredDisclaimers.join("\n- ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * How hard the piece is allowed to sell.
 *
 * Left unsaid, a model writing for a company's own blog drifts into promoting
 * that company, and an article that reads as an ad stops being read. QC counts
 * the mentions against the same ceiling.
 */
function renderPromotion(brief: ContentBrief): string {
  const parts: string[] = [];

  if (brief.productToFeature) {
    const level = brief.promotionLevel.toLowerCase();
    if (level.startsWith("do not")) {
      parts.push(
        `PROMOTION — do NOT name "${brief.productToFeature}" or any of the business's products anywhere in this piece. It earns attention by being useful, not by selling.`,
      );
    } else if (level.startsWith("feature")) {
      parts.push(
        `PROMOTION — "${brief.productToFeature}" may be named where it genuinely answers the reader's problem, at most a handful of times across the whole piece. Show what it does in context; never list features and never write a pitch.`,
      );
    } else {
      parts.push(
        `PROMOTION — "${brief.productToFeature}" may be mentioned at most twice, and only where a reader would genuinely want to know it exists. The piece must stand up completely for someone who will never buy it.`,
      );
    }
  }

  if (brief.ctaGoal) {
    parts.push(
      `WHAT THE READER SHOULD DO NEXT: ${brief.ctaGoal}. Land this in the closing section as a concrete next step, in a normal sentence. No sales block, no urgency language.`,
    );
  }
  if (brief.ctaUrl) {
    parts.push(
      `Link that next step to ${brief.ctaUrl} exactly once, with a short natural anchor, and mark it kind="internal" in links_used.`,
    );
  }

  return parts.join("\n");
}

function renderInternalLinks(brief: ContentBrief): string {
  if (brief.internalLinks.length === 0) {
    return "INTERNAL LINKS — none were supplied, so do not invent one. Do not link to the business's own site at all.";
  }
  const list = brief.internalLinks
    .map((link) => (link.anchor ? `- ${link.url} — use the exact anchor "${link.anchor}"` : `- ${link.url}`))
    .join("\n");
  return [
    "INTERNAL LINKS — link each of these once, from a sentence where it genuinely helps the reader. Mark them kind=\"internal\" in links_used.",
    list,
    'Where an exact anchor is given, use those words verbatim and write the sentence around them. Otherwise pick a short, natural 1-3 word anchor. Never put an internal link in the first sentence.',
  ].join("\n");
}

/**
 * One repair round: hand the writer its own article back with the defects QC
 * found, and take a corrected submission.
 *
 * Deliberately a rewrite of the whole article rather than a patch. A patch pass
 * reliably fixes the flagged sentence and breaks the paragraph around it.
 */
export async function repairArticle(
  client: Anthropic,
  brief: ContentBrief,
  research: ResearchResult,
  article: Article,
  defects: string[],
): Promise<{ article: Article; costUsd: number }> {
  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: buildSystemPrompt(brief),
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];

  const prompt = [
    "You wrote the article below. An editor has reviewed it and found the defects listed underneath. Fix every one and resubmit the COMPLETE article through submit_article.",
    "",
    "Rules for this pass:",
    "- Return the whole article, not a patch. Every section, including the ones with no defect.",
    "- Change as little as each fix requires. Do not rewrite clean paragraphs, do not rename sections that are fine, and do not drift off the brief.",
    "- Do not introduce a new defect while fixing another. Re-read the voice rules before you submit.",
    brief.webResearch
      ? "- To add or re-link a reference, use ONLY the verified sources listed below. Never invent a URL."
      : "- Do not add any external link or any statistic.",
    "",
    "DEFECTS TO FIX",
    defects.map((d, i) => `${i + 1}. ${d}`).join("\n"),
    "",
    // Restated, because a defect list alone does not tell the writer what the
    // brief asked for. A first draft that skipped the FAQ came back from repair
    // having skipped it again: the defect said it was missing, nothing said what
    // it should contain.
    renderDeliverables(brief),
    "",
    renderLengthInstruction(brief.length),
    overLength(article, brief),
    "",
    renderResearch(research, brief),
    "",
    "THE CURRENT ARTICLE",
    renderMarkdown(article),
  ].join("\n");

  const { submitted, costUsd } = await runWriter(
    client,
    system,
    prompt,
    brief,
    maxTokensFor(brief.length.max),
    // No search on a repair round: the verified sources are already in the
    // prompt, and a second search pass is where invented URLs creep back in.
    false,
  );

  return {
    article: normaliseArticle(submitted, { focusKeyword: brief.targetKeyword }),
    costUsd,
  };
}
