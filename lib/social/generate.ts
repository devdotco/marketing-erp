import Anthropic from "@anthropic-ai/sdk";
import type { Site } from "@/lib/social/auto-post-sites";

const client = new Anthropic();

export interface GeneratePostOptions {
  topic: string;
  tone?: "professional" | "conversational" | "educational" | "storytelling" | "bold";
  length?: "short" | "medium" | "long";
  context?: string;
  hashtags?: boolean;
  callToAction?: string;
}

export async function generatePost(opts: GeneratePostOptions): Promise<string> {
  const {
    topic,
    tone = "professional",
    length = "medium",
    context,
    hashtags = true,
    callToAction,
  } = opts;

  const wordCount = { short: "80–120", medium: "150–250", long: "300–500" }[length];

  const systemPrompt = `You are an expert LinkedIn content writer. You write posts that get high engagement — clear, human, and genuinely valuable. You avoid corporate jargon, excessive buzzwords, and hollow inspirational quotes.

LinkedIn post rules:
- Hook in the first line (no more than 12 words — this is what shows before "see more")
- Short paragraphs (1–3 lines max), white space is essential
- Specific > general. Numbers, examples, and stories beat abstractions
- End with something that invites engagement (question, perspective, CTA)
- ${hashtags ? "Add 3–5 relevant hashtags at the end" : "No hashtags"}
${context ? `\nContext about the author/brand: ${context}` : ""}`;

  const userPrompt = `Write a LinkedIn post about: ${topic}

Tone: ${tone}
Length: ${wordCount} words
${callToAction ? `Call to action: ${callToAction}` : ""}

Return ONLY the post text, nothing else.`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const text = message.content[0].type === "text" ? message.content[0].text : "";
  return text.trim();
}

export interface GenerateCalendarOptions {
  niche: string;
  goal: string;
  audience: string;
  tone?: string;
  postsPerWeek?: number;
  weeks?: number;
}

export interface CalendarPost {
  day: number;
  topic: string;
  angle: string;
  format: string;
}

export async function generateCalendar(opts: GenerateCalendarOptions): Promise<CalendarPost[]> {
  const { niche, goal, audience, tone = "professional", postsPerWeek = 3, weeks = 4 } = opts;

  const totalPosts = postsPerWeek * weeks;

  const userPrompt = `Create a LinkedIn content calendar with ${totalPosts} post ideas for:
- Niche: ${niche}
- Goal: ${goal}
- Audience: ${audience}
- Tone: ${tone}

Return a JSON array (no markdown, raw JSON only) with ${totalPosts} objects, each with:
{ "day": <1-${totalPosts * 2}>, "topic": "<specific topic>", "angle": "<unique angle/hook>", "format": "<story|list|insight|question|case-study>" }

Space the days out by ${Math.round(7 / postsPerWeek)} days between posts. Vary formats. Make topics specific and timely, not generic.`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [{ role: "user", content: userPrompt }],
  });
  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const json = text.replace(/```json\n?|\n?```/g, "").trim();
  return JSON.parse(json) as CalendarPost[];
}

export async function generateAutoPost(site: Site, subPage: { url: string; title: string; description: string }): Promise<string> {
  const systemPrompt = `You are an expert LinkedIn content writer for a portfolio of premium web domains. You write posts that earn genuine engagement — clear, direct, and valuable.

LinkedIn post rules:
- First line is the hook (12 words or fewer, must make the reader stop scrolling)
- The homepage URL (${site.homepage}) must appear naturally in the first 20 words of the post body — weave it in, do not just drop it
- Short paragraphs (1 to 3 lines), lots of white space
- Midway through the post, reference this specific page from the same site: ${subPage.url} — describe what it covers in 1 to 2 sentences so readers know why to click
- End with a question or clear takeaway that invites comments
- Add 4 to 6 highly relevant hashtags on the last line
- Specific beats generic. Use real numbers, examples, or industry context
- Do NOT use hollow phrases like "game-changer", "leverage", "unlock", or "in today's fast-paced world"
- NEVER use dashes of any kind (no hyphens used as bullets, no em dashes, no arrows like "->", no "—", no "–")
- NEVER use asterisks or bold markers (* or **)
- Use plain sentences and line breaks for structure, not punctuation symbols`;

  const userPrompt = `Write a LinkedIn post promoting ${site.name} (${site.homepage}).

About the site: ${site.tagline}

The post must:
1. Open with a punchy hook (≤12 words)
2. Naturally include ${site.homepage} within the first 20 words of the body
3. Be about one of these topics: ${site.topics.join(", ")}
4. Midway, reference and briefly describe this internal page: "${subPage.title}" at ${subPage.url} — here's what it covers: ${subPage.description}
5. Close with an engaging question or strong takeaway
6. End with 4–6 relevant hashtags

Length: 150–280 words total.

Return ONLY the post text, nothing else.`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const text = message.content[0].type === "text" ? message.content[0].text : "";
  return text.trim();
}

// Re-export SubPage type so callers don't need a separate import
export type { SubPage } from "@/lib/social/auto-post-sites";
