import type Anthropic from "@anthropic-ai/sdk";
import { assertNotTruncated, textFrom, toolInputFrom } from "@/lib/ai/extract";
import { createMessage } from "@/lib/ai/messages";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { asArray, strictSchema } from "./article";
import type { ContentBrief } from "./brief";
import { domainList } from "./domains";

export interface VettedSource {
  url: string;
  publisher: string;
  title: string;
  supports: string;
}

export interface ClaimEvidence {
  claim: string;
  sourceUrl: string;
}

interface SubmittedResearch {
  sources?: VettedSource[];
  claims?: ClaimEvidence[];
  angles?: string[];
}

export interface ResearchResult {
  sources: VettedSource[];
  claims: ClaimEvidence[];
  angles: string[];
  costUsd: number;
  searched: boolean;
}

export const SUBMIT_RESEARCH_TOOL: Anthropic.Tool = {
  name: "submit_research",
  // Without this the input is only best-effort JSON. A live run returned
  // `angles` as the string '\n<parameter name="angles">["…"]' — the model's own
  // parameter syntax leaking into the value — and dropped `sources` entirely.
  // The search had genuinely found sixteen good pages; every one was lost, and
  // the article was written unsourced with nothing in the logs to say why.
  strict: true,
  description:
    "Submit the verified sources and the specific claims each one supports, after searching. Only submit sources whose URL you actually saw in a search result.",
  input_schema: strictSchema({
    type: "object",
    required: ["sources", "claims", "angles"],
    properties: {
      sources: {
        type: "array",
        description:
          "Authoritative pages found via web_search that are genuinely relevant to this article. Copy each URL verbatim from the search result. Never a homepage, category index, or Wikipedia page.",
        items: {
          type: "object",
          required: ["url", "publisher", "title", "supports"],
          properties: {
            url: { type: "string" },
            publisher: { type: "string", description: "Who published it, e.g. Pew Research." },
            title: { type: "string" },
            supports: {
              type: "string",
              description: "What this page can be cited for, in one sentence.",
            },
          },
        },
      },
      claims: {
        type: "array",
        description:
          "Specific, citable facts the article may assert, each bound to the source URL that actually states it. If a fact is not here, the writer may not assert it.",
        items: {
          type: "object",
          required: ["claim", "sourceUrl"],
          properties: {
            claim: {
              type: "string",
              description: "The fact as it could be written, including the figure and its date.",
            },
            sourceUrl: {
              type: "string",
              description: "One of the source URLs above — the page that actually states this.",
            },
          },
        },
      },
      angles: {
        type: "array",
        description:
          "Angles worth taking that the competing articles miss, or that the search results show are underserved. One short sentence each.",
        items: { type: "string" },
      },
    },
  }),
};

function webSearchTool(brief: ContentBrief): Anthropic.WebSearchTool20250305 {
  const tool: Anthropic.WebSearchTool20250305 = {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 8,
  };
  // Two rules the API enforces and both are easy to trip: the filters are
  // mutually exclusive, and neither list may contain a duplicate. Duplicates are
  // the likely case now that a workspace's blocked list merges with its
  // editorial profile's — "wikipedia.org" arrives from both. Normalise to bare
  // hosts first, so example.com and https://www.example.com/ collapse to one.
  if (brief.preferredSources.length > 0) {
    tool.allowed_domains = domainList(brief.preferredSources);
  } else if (brief.blockedDomains.length > 0) {
    tool.blocked_domains = domainList(brief.blockedDomains);
  }
  return tool;
}

/** The research instruction. Exported so it can be exercised without a full run. */
export function buildResearchAsk(brief: ContentBrief): string {
  return [
    `Research an article on: ${brief.topicBrief}`,
    brief.targetKeyword ? `Primary keyword: "${brief.targetKeyword}"` : "",
    brief.audienceDescription ? `Reader: ${brief.audienceDescription}` : "",
    brief.mustCover.length > 0 ? `The article must cover:\n- ${brief.mustCover.join("\n- ")}` : "",
    brief.keyQuestions.length > 0
      ? `It must answer these questions, so find what is needed to answer them well:\n- ${brief.keyQuestions.join("\n- ")}`
      : "",
    brief.competitorUrls.length > 0
      ? `Competing articles the piece has to beat:\n- ${brief.competitorUrls.join("\n- ")}`
      : "",
    "",
    "Use web_search to find authoritative pages that genuinely support this topic: original studies, government (.gov) and university (.edu) pages, standards bodies, major research firms, and major publications. Never Wikipedia, never a content farm, never a homepage or category index.",
    brief.includeStatistics
      ? `Find enough material for at least ${Math.max(3, brief.externalLinkCount)} distinct citable claims, each with a real figure and its date.`
      : "Do not collect statistics. Find reference pages that define, explain, or provide authoritative background only, and return an empty claims list.",
    brief.sourceRecencyYears > 0
      ? `RECENCY: prefer sources published within the last ${brief.sourceRecencyYears} year${brief.sourceRecencyYears === 1 ? "" : "s"}. An older source is acceptable only when it is the primary or definitive one (an originating study, a standard, a statute) — say so in its "supports" line when you keep one.`
      : "",
    brief.blockedDomains.length > 0 ? `Never return these domains: ${brief.blockedDomains.join(", ")}` : "",
    brief.preferredSourceNotes.length > 0
      ? `Source preferences from the brief (guidance, not a hard filter):\n- ${brief.preferredSourceNotes.join("\n- ")}`
      : "",
    brief.blockedSourceNotes.length > 0
      ? `Sources the brief rules out — judge each result against these and leave out anything that matches:\n- ${brief.blockedSourceNotes.join("\n- ")}`
      : "",
    "",
    "Then call submit_research. Copy every URL verbatim from a search result — never reconstruct one from memory, and never include a page you did not actually see returned.",
  ]
    .filter(Boolean)
    .join("\n");

}

/**
 * Claim-first sourcing: find the sources BEFORE writing, and bind each citable
 * fact to the page that actually states it.
 *
 * This is the step that makes "Research and Verify Claims" real. Without it the
 * writer recalls figures from memory and attaches a plausible-looking URL, which
 * is how an article ends up citing a page that does not contain its statistic.
 * The draft prompt then permits only the facts listed here.
 */
export async function planSources(
  client: Anthropic,
  brief: ContentBrief,
): Promise<ResearchResult> {
  if (!brief.webResearch) {
    return { sources: [], claims: [], angles: [], costUsd: 0, searched: false };
  }

  const ask = buildResearchAsk(brief);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: ask }];
  const system =
    "You are a research editor. You verify before you assert. A source you did not actually see in a search result does not exist, and a claim you cannot bind to a specific page does not go in the article.";

  const first = await createMessage(client, {
    model: MODELS.standard,
    // Search result blocks come back inside the response and are charged as
    // output, so this budget covers the searching as well as the answer.
    max_tokens: 24000,
    system,
    tools: [webSearchTool(brief), SUBMIT_RESEARCH_TOOL],
    messages,
  });

  assertNotTruncated(first, "Source research");
  let costUsd = estimateCostUsd(MODELS.standard, first.usage);
  let submitted = toolInputFrom<SubmittedResearch>(first, "submit_research");

  // Two ways this arrives useless, and both used to pass silently as "no sources
  // found": the model answers in prose instead of calling the tool, or it calls
  // the tool with claims but no sources (a malformed submission — the claims
  // then fail the vetted-URL filter and everything is discarded). Either way the
  // search itself worked, so ask again rather than writing an unsourced piece.
  if (!submitted || looksMalformed(submitted)) {
    messages.push({ role: "assistant", content: first.content });
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text:
            "That submission was not usable: the sources array was missing or empty. Call submit_research now with every source URL exactly as it appeared in a search result, and the specific claims each one supports, as plain JSON arrays. If the searches genuinely found nothing usable, call it with empty arrays rather than inventing anything. " +
            (textFrom(first) ? "Do not restate your findings as prose." : ""),
        },
      ],
    });

    const second = await createMessage(client, {
      model: MODELS.standard,
      max_tokens: 8000,
      system,
      tools: [SUBMIT_RESEARCH_TOOL],
      tool_choice: { type: "tool", name: "submit_research" },
      messages,
    });

    assertNotTruncated(second, "Source research");
    costUsd += estimateCostUsd(MODELS.standard, second.usage);
    submitted = toolInputFrom<SubmittedResearch>(second, "submit_research");
  }

  const sources = asArray<VettedSource>(submitted?.sources).filter(
    (s) => s?.url && /^https?:\/\//i.test(s.url) && !/wikipedia\.org/i.test(s.url),
  );
  const sourceUrls = new Set(sources.map((s) => s.url));

  return {
    sources,
    // A claim bound to a URL that is not in the vetted list is exactly the
    // fabrication this step exists to prevent. Drop it rather than pass it on.
    claims: asArray<ClaimEvidence>(submitted?.claims).filter(
      (c) => c?.claim && sourceUrls.has(c.sourceUrl),
    ),
    angles: asArray<unknown>(submitted?.angles).filter(
      (a): a is string => typeof a === "string" && a.trim() !== "",
    ),
    costUsd,
    searched: true,
  };
}

/**
 * True when a submission cannot be used, however well-formed it looks.
 *
 * Claims without sources is the giveaway. It means the model found material and
 * then failed to serialise the sources array — every claim is about to be
 * dropped by the vetted-URL filter, and the run would continue as though the
 * search had come back empty.
 */
function looksMalformed(submitted: SubmittedResearch): boolean {
  const sources = asArray<VettedSource>(submitted.sources);
  const claims = asArray<ClaimEvidence>(submitted.claims);
  return sources.length === 0 && claims.length > 0;
}

/** The CLAIM EVIDENCE block handed to the writer. */
export function renderResearch(research: ResearchResult, brief: ContentBrief): string {
  if (!research.searched) {
    return [
      "NO RESEARCH PASS WAS RUN for this article — web research is switched off in the brief.",
      "You therefore may NOT state any statistic, figure, dated finding, or claim attributed to a named source. Write from general reasoning and domain knowledge only, and include no external links.",
    ].join("\n");
  }

  if (research.sources.length === 0) {
    return [
      "THE RESEARCH PASS FOUND NO USABLE SOURCES.",
      "Do not invent one. Write the article from general reasoning with no statistics, no named sources, and no external links, and say so in qc_notes.",
    ].join("\n");
  }

  const sources = research.sources
    .map((s) => `- ${s.publisher}: "${s.title}" — ${s.url}\n  Citable for: ${s.supports}`)
    .join("\n");

  const claims =
    research.claims.length > 0
      ? research.claims.map((c) => `- ${c.claim}\n  Source: ${c.sourceUrl}`).join("\n")
      : "(none — do not state any statistic or dated finding in this article)";

  return [
    "VERIFIED SOURCES — these URLs were found by search and confirmed. You may link ONLY these, and you must copy each URL character for character.",
    sources,
    "",
    "CLAIM EVIDENCE — the complete list of specific facts you are permitted to assert.",
    "You may state a fact ONLY if it appears below, and it must carry a hyperlink to the source bound to it. Anything else must be written as your own general reasoning, with no figure and no named source.",
    claims,
    research.angles.length > 0
      ? `\nANGLES THE COMPETING COVERAGE MISSES — lean into these:\n${research.angles.map((a) => `- ${a}`).join("\n")}`
      : "",
    brief.externalLinkCount > 0
      ? `\nLINK BUDGET — include ${brief.externalLinkCount} external reference link${brief.externalLinkCount === 1 ? "" : "s"}, each to a DIFFERENT source from the verified list. Link any one source at most once.`
      : "\nLINK BUDGET — this article carries no external links. Do not add any.",
  ]
    .filter(Boolean)
    .join("\n");
}
