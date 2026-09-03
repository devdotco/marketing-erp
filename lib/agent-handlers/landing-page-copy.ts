import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const landingPageCopyHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const offerDescription =
    typeof config.offerDescription === "string" ? config.offerDescription : "";
  const targetBuyer =
    typeof config.targetBuyer === "string" ? config.targetBuyer : "";
  const mainObjections =
    typeof config.mainObjections === "string" ? config.mainObjections : "";
  const socialProofCount =
    typeof config.socialProofCount === "number" ? config.socialProofCount : 3;
  const pageGoal =
    typeof config.pageGoal === "string" ? config.pageGoal : "Lead Gen";

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandVoiceStr =
    businessProfile?.brandVoice != null
      ? String(businessProfile.brandVoice)
      : "";

  const competitorsStr =
    businessProfile?.competitors?.length
      ? businessProfile.competitors.join(", ")
      : "";

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        brandVoiceStr ? `Brand voice: ${brandVoiceStr}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.uniqueValueProp ? `Unique value proposition: ${businessProfile.uniqueValueProp}` : "",
        competitorsStr ? `Competitors: ${competitorsStr}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const systemPrompt = [
    "You are a world-class direct response copywriter.",
    "You are an expert at three distinct landing page frameworks:",
    "1. pain-led — Agitate the reader's problem until the offer feels like relief.",
    "2. outcome-led — Paint a vivid, desirable transformation the reader will experience.",
    "3. proof-led — Let results, testimonials, and data do the persuasion.",
    "Each variant must be substantially different — different headlines, different emotional angles, different copy rhythm. Never recycle sentences across variants.",
    "You write copy that converts. Every word earns its place. CTAs are specific and action-oriented.",
    "Return ONLY valid JSON — no markdown fences, no preamble, no trailing commentary.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const ctaByGoal: Record<string, { primary: string; secondary: string }> = {
    "Lead Gen": { primary: "Get Your Free Consultation", secondary: "See How It Works" },
    "Demo Request": { primary: "Book a Live Demo", secondary: "Watch a 2-Minute Overview" },
    Purchase: { primary: "Buy Now", secondary: "See Pricing" },
    Signup: { primary: "Start Free", secondary: "Learn More" },
  };
  const defaultCta = ctaByGoal[pageGoal] ?? ctaByGoal["Lead Gen"];

  const userPrompt = [
    `Write 3 complete, substantially different landing page copy variants for the following offer.`,
    `Page goal: ${pageGoal}`,
    "",
    offerDescription ? `Offer description:\n${offerDescription}` : "",
    targetBuyer ? `\nTarget buyer:\n${targetBuyer}` : "",
    mainObjections ? `\nMain objections to overcome:\n${mainObjections}` : "",
    `\nInclude ${socialProofCount} social proof testimonials per variant (invent plausible ones if none are provided — mark invented ones with sourceUrl: null).`,
    "",
    "Variant names must be exactly: pain-led, outcome-led, proof-led.",
    "Each variant needs all fields populated — no placeholders, no 'TBD'.",
    `Default CTA if not naturally implied by the copy: primary="${defaultCta.primary}", secondary="${defaultCta.secondary}"`,
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      variants: [
        {
          name: "pain-led",
          headline: "The main H1 headline",
          subheadline: "Supporting subheadline below the H1",
          heroBody: "2–3 sentence hero section body copy",
          valueProps: [
            {
              icon: "emoji or icon name suggestion",
              title: "Value prop title",
              description: "One sentence description",
            },
          ],
          socialProof: [
            {
              quote: "Testimonial quote",
              author: "First Last",
              company: "Company Name",
            },
          ],
          objectionHandlers: [
            {
              objection: "Common objection",
              response: "Empathetic, persuasive response",
            },
          ],
          cta: {
            primary: "Primary CTA button text",
            secondary: "Secondary CTA link text",
          },
          closingStatement: "Final sentence before the CTA — creates urgency or reassurance",
        },
        {
          name: "outcome-led",
          headline: "",
          subheadline: "",
          heroBody: "",
          valueProps: [],
          socialProof: [],
          objectionHandlers: [],
          cta: { primary: "", secondary: "" },
          closingStatement: "",
        },
        {
          name: "proof-led",
          headline: "",
          subheadline: "",
          heroBody: "",
          valueProps: [],
          socialProof: [],
          objectionHandlers: [],
          cta: { primary: "", secondary: "" },
          closingStatement: "",
        },
      ],
    }),
  ]
    .filter(Boolean)
    .join("\n");

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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};
