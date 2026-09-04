import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

interface RedditPost {
  title: string;
  selftext: string;
  author: string;
  subreddit: string;
  score: number;
  url: string;
  permalink: string;
  created_utc: number;
  num_comments: number;
}

export const socialListeningHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const brandKeywords = (config.brandKeywords as string) ?? "";
  const competitors = (config.competitors as string) ?? "";
  const platforms = (config.platforms as string) ?? "All";
  const sentimentAlert = config.sentimentAlert !== false;
  const digestFrequency = (config.digestFrequency as string) ?? "Daily";

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandName = businessProfile?.businessName ?? brandKeywords.split(/[\n,]+/)[0]?.trim() ?? "brand";

  // ── Live Reddit search (public API, no auth required) ──────────────────
  const keywords = [
    brandName,
    ...brandKeywords.split(/[\n,]+/).map((k) => k.trim()).filter(Boolean).slice(0, 2),
  ].filter(Boolean);

  const competitorList = competitors
    .split(/[\n,]+/)
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 3);

  type RedditChild = { data: RedditPost };
  type RedditSearchResponse = { data?: { children?: RedditChild[] } };

  const redditMentions: RedditPost[] = [];
  const redditCompetitorMentions: Array<{ competitor: string; post: RedditPost }> = [];
  let isLive = false;

  const includeReddit = platforms === "All" || platforms.toLowerCase().includes("reddit");

  if (includeReddit) {
    try {
      const searchTerms = keywords.slice(0, 2);
      for (const term of searchTerms) {
        const encodedTerm = encodeURIComponent(term);
        const res = await fetch(
          `https://www.reddit.com/search.json?q=${encodedTerm}&sort=new&limit=25&type=link&t=week`,
          {
            headers: {
              "User-Agent": "marketing-erp-social-listener/1.0 (monitoring; contact nate@dev.co)",
              Accept: "application/json",
            },
          }
        );
        if (res.ok) {
          const data = (await res.json()) as RedditSearchResponse;
          const children = data.data?.children ?? [];
          for (const child of children) {
            const post = child.data;
            // Score filter: only include posts with ≥2 upvotes or ≥1 comment
            if (post.score >= 2 || post.num_comments >= 1) {
              redditMentions.push(post);
            }
          }
          isLive = true;
        }
      }

      // Search for competitor mentions
      for (const competitor of competitorList) {
        const encodedComp = encodeURIComponent(competitor);
        const res = await fetch(
          `https://www.reddit.com/search.json?q=${encodedComp}&sort=new&limit=10&type=link&t=week`,
          {
            headers: {
              "User-Agent": "marketing-erp-social-listener/1.0 (monitoring; contact nate@dev.co)",
              Accept: "application/json",
            },
          }
        );
        if (res.ok) {
          const data = (await res.json()) as RedditSearchResponse;
          const children = data.data?.children ?? [];
          for (const child of children) {
            if (child.data.score >= 2) {
              redditCompetitorMentions.push({ competitor, post: child.data });
            }
          }
        }
      }
    } catch {
      // Non-fatal — fall through to simulation context
    }
  }

  // Build live context string for Claude
  const liveRedditContext = isLive
    ? `LIVE REDDIT MENTIONS (last 7 days):
Brand mentions found: ${redditMentions.length}

Top brand mentions:
${redditMentions.slice(0, 10).map((p) =>
      `- [${p.subreddit}] "${p.title}" by u/${p.author} | Score: ${p.score} | Comments: ${p.num_comments}
  URL: https://reddit.com${p.permalink}
  Body: ${p.selftext ? p.selftext.slice(0, 200) : "(link post)"}`
    ).join("\n\n")}

Competitor mentions on Reddit:
${redditCompetitorMentions.slice(0, 8).map((m) =>
      `- [${m.competitor}] "${m.post.title}" by u/${m.post.author} | Score: ${m.post.score}
  URL: https://reddit.com${m.post.permalink}`
    ).join("\n")}

Use the above REAL data to populate topMentions (Reddit posts), identify genuine sentiment patterns, and flag any PR risks or competitor moves you can infer.`
    : "";

  const systemPrompt = `You are a brand monitoring analyst. ${isLive ? "You have REAL Reddit data below — use it to populate the digest with actual posts, authors, and URLs." : "Simulate realistic brand monitoring data."} Flag anything requiring urgent response (negative viral content, product issues, PR risks) separately from routine mentions. Draft suggested replies that sound like a knowledgeable human, not a PR agency. Respond ONLY with valid JSON — no markdown, no code fences.`;

  const userPrompt = `Generate a ${digestFrequency.toLowerCase()} brand monitoring digest for ${brandName}.

Business context:
- Industry: ${businessProfile?.industry ?? "General"}
- Value proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}
- Target audience: ${businessProfile?.targetAudience ?? "Not specified"}

Monitoring configuration:
- Brand keywords: ${keywords.join(", ")}
- Competitors to watch: ${competitorList.join(", ") || "None specified"}
- Platforms: ${platforms}
- Sentiment alerts enabled: ${sentimentAlert}
- Digest frequency: ${digestFrequency}

${liveRedditContext}

Return exactly this JSON structure:
{
  "digest": {
    "period": "${digestFrequency} digest — ${isLive ? "live Reddit data" : "simulated"}",
    "mentionCount": 0,
    "redditMentionCount": ${redditMentions.length},
    "sentimentBreakdown": { "positive": 0, "neutral": 0, "negative": 0 },
    "topMentions": [
      {
        "platform": "Reddit | X | LinkedIn | Facebook",
        "content": "mention text or post title",
        "author": "username",
        "url": "https://reddit.com/...",
        "sentiment": "positive | neutral | negative",
        "suggestedReply": "reply text or null",
        "requiresResponse": false,
        "score": 0,
        "commentCount": 0
      }
    ],
    "competitorActivity": [
      {
        "competitor": "competitor name",
        "noteworthy": "what they did",
        "implication": "what it means for you",
        "platform": "Reddit | X | LinkedIn"
      }
    ],
    "alerts": [
      {
        "type": "negative_viral | pr_risk | product_issue | competitor_move",
        "message": "alert description",
        "severity": "low | medium | high",
        "url": "link to the post if available"
      }
    ]
  },
  "source": "${isLive ? "live" : "simulation"}",
  "simulationNote": ${isLive ? "null" : '"Connect X and Reddit integrations in Settings to monitor real mentions. Reddit data shown is live via public API."'}
}`;

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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;
  if (isLive) {
    output.source = "live";
    output.redditPostsAnalyzed = redditMentions.length;
    delete output.simulationNote;
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};
