import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { lines, num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const landingPageCopyHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  // Renamed to the Run form's key on 2026-09-14; a saved targetBuyer still works.
  applyRenamedInputs(run, config, { audienceDescription: "targetBuyer" });

  const offerDescription = str(config, "offerDescription");
  const audienceDescription = str(config, "audienceDescription");
  const mainObjections = str(config, "mainObjections");
  const socialProofCount = num(config, "socialProofCount", 3, { min: 0, max: 6 });
  const pageGoal = str(config, "pageGoal", "Lead generation");
  const targetKeyword = str(config, "targetKeyword");
  const competitorUrls = lines(config, "competitorUrls", 3);
  const ctaButtonText = str(config, "ctaButtonText");
  const wordCountTarget = num(config, "wordCountTarget", 600, { min: 150, max: 3000 });
  const toneOverride = str(config, "toneOverride", "Use Brand Profile default");

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

  // Keyed by the form's Page Goal options (this map used to use labels the form never offered,
  // so every goal fell through to the Lead Gen CTAs).
  const leadGen = { primary: "Get Your Free Consultation", secondary: "See How It Works" };
  const demo = { primary: "Book a Live Demo", secondary: "Watch a 2-Minute Overview" };
  const purchase = { primary: "Buy Now", secondary: "See Pricing" };
  const signup = { primary: "Start Free", secondary: "Learn More" };
  const ctaByGoal: Record<string, { primary: string; secondary: string }> = {
    "Lead generation": leadGen,
    "Demo booking": demo,
    "Free trial signup": signup,
    "Direct purchase": purchase,
    "Content download": { primary: "Download the Guide", secondary: "See What's Inside" },
  };
  const goalCta = ctaByGoal[pageGoal] ?? leadGen;
  const defaultCta = ctaButtonText ? { primary: ctaButtonText, secondary: goalCta.secondary } : goalCta;
  const toneLine = toneOverride && toneOverride !== "Use Brand Profile default"
    ? `Tone for this page (overrides the brand voice): ${toneOverride}`
    : "";

  const userPrompt = [
    `Write 3 complete, substantially different landing page copy variants for the following offer.`,
    `Page goal: ${pageGoal}`,
    targetKeyword ? `Target keyword: ${targetKeyword} — use it in every variant's H1 or subheadline, the meta title, and the first sentence of the hero body.` : "",
    `Aim for about ${wordCountTarget} words of page copy per variant, all sections combined.`,
    toneLine,
    "",
    offerDescription ? `Offer description:\n${offerDescription}` : "",
    audienceDescription ? `\nTarget audience:\n${audienceDescription}` : "",
    mainObjections ? `\nMain objections to overcome:\n${mainObjections}` : "",
    competitorUrls.length > 0
      ? `\nCompetitor landing pages to differentiate from (you have the URLs only, not the page content — do not claim to know what they say):\n${competitorUrls.join("\n")}`
      : "",
    `\nInclude ${socialProofCount} social proof testimonials per variant (invent plausible ones if none are provided — mark invented ones with sourceUrl: null).`,
    "",
    "Variant names must be exactly: pain-led, outcome-led, proof-led.",
    "Each variant needs all fields populated — no placeholders, no 'TBD'.",
    ctaButtonText
      ? `Preferred primary CTA button label: "${ctaButtonText}". Use it as the primary CTA in one variant and write two alternative labels for the other two, for A/B testing. Secondary CTA default: "${defaultCta.secondary}"`
      : `Default CTA if not naturally implied by the copy: primary="${defaultCta.primary}", secondary="${defaultCta.secondary}"`,
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
          seo: { metaTitle: "Meta title under 60 characters", metaDescription: "Meta description under 155 characters" },
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
          seo: { metaTitle: "", metaDescription: "" },
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
          seo: { metaTitle: "", metaDescription: "" },
        },
      ],
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

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};
