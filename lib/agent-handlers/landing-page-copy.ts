import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { jsonFrom, textFrom } from "@/lib/ai/extract";
import { addReview } from "@/lib/agents/integrity";
import { finalizeVariants, parseTestimonials, type Variant } from "@/lib/agents/claim-check";
import { lines, num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { completeMessage } from "@/lib/ai/messages";

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
  const proofPoints = str(config, "proofPoints");
  const testimonials = parseTestimonials(str(config, "testimonials"));
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
    "Each variant must be substantially different: it leads with a DIFFERENT primary benefit, uses a DIFFERENT hero structure (for example question, bold claim, scenario, or before/after), and never recycles sentences. The outcome-led variant must not open with the same deliverable or promise as the pain-led one.",
    "You never invent facts. Every number, percentage, count, rating, duration, client or industry claim, award, or guarantee must appear in the offer description, proof points, audience, or Client context supplied. If it is not there, do not state it. Where proof would help but none was supplied, write [PROOF NEEDED: <what kind of proof>] inline so the gap is visible.",
    "You never write testimonials, customer names, or quotes.",
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
    proofPoints ? `\nVerified proof points (the ONLY company statistics you may state, verbatim):\n${proofPoints}` : "\nNo proof points were supplied, so you may state NO company statistics, client counts, ratings, years in business, or industries served.",
    "",
    "Rules for every variant:",
    "- The same fact is stated identically everywhere (headline, body, meta description). Timelines, deliverables, and what happens on a call must match the offer description exactly; do not add or compress steps.",
    "- No absolutes (always, never, no exceptions, guaranteed, 100%, risk-free) unless the offer text makes that exact commitment.",
    "- Each variant has a different primary benefit and hero structure. Do not let two variants make the same promise.",
    "- proof-led with no proof points: lean on process, specificity, and [PROOF NEEDED: ...] markers, never on invented numbers.",
    targetKeyword ? "- Use the keyword naturally, never forced into an awkward headline. The business name appears in at least the hero body; do not force it into the H1." : "- The business name appears in at least the hero body; do not force it into the H1.",
    "- howItWorks: 3-4 steps drawn ONLY from the offer description. It is the target of the secondary CTA, so word the secondary CTA differently per variant (e.g. 'See the Process', 'Walk Through the Steps').",
    "- Do NOT write testimonials. socialProofGuidance is one short sentence per slot (no numbers) describing what kind of real customer quote would suit this variant.",
    "- reviewNotes: list anything you were unsure of or had to leave out; use [] if nothing.",
    "",
    "Variant names must be exactly: pain-led, outcome-led, proof-led.",
    "Each variant needs all fields populated. Use [PROOF NEEDED: ...] only for missing proof; never 'TBD'.",
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
          howItWorks: [{ title: "Step title", description: "One sentence, from the offer description only" }],
          socialProofGuidance: socialProofCount > 0 ? Array.from({ length: Math.max(0, socialProofCount - testimonials.length) }, () => "What kind of real customer quote fits here (no numbers)") : [],
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
          reviewNotes: ["Anything you were unsure of"],
        },
        {
          name: "outcome-led",
          headline: "",
          subheadline: "",
          heroBody: "",
          valueProps: [],
          howItWorks: [],
          socialProofGuidance: [],
          objectionHandlers: [],
          cta: { primary: "", secondary: "" },
          closingStatement: "",
          seo: { metaTitle: "", metaDescription: "" },
          reviewNotes: [],
        },
        {
          name: "proof-led",
          headline: "",
          subheadline: "",
          heroBody: "",
          valueProps: [],
          howItWorks: [],
          socialProofGuidance: [],
          objectionHandlers: [],
          cta: { primary: "", secondary: "" },
          closingStatement: "",
          seo: { metaTitle: "", metaDescription: "" },
          reviewNotes: [],
        },
      ],
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

  const rawText = textFrom(message);
  const output: Record<string, unknown> = jsonFrom(rawText) ?? { result: rawText };

  // Checked against everything the user told us, because that is the only
  // evidence a claim can have. Testimonials are excluded: they are verified
  // separately and a number inside a quote is not a company fact.
  const variants = Array.isArray(output.variants) ? (output.variants as Variant[]).filter((v) => v && typeof v === "object") : [];
  if (variants.length > 0) {
    output.variants = variants;
    const warnings = finalizeVariants(variants, {
      inputText: [offerDescription, proofPoints, audienceDescription, mainObjections, targetKeyword, ctaButtonText, brandContext].join("\n"),
      testimonials,
      socialProofCount,
      keyword: targetKeyword,
      wordCountTarget,
      defaultSecondaryCta: defaultCta.secondary,
    });
    if (socialProofCount > testimonials.length) {
      warnings.unshift(`${socialProofCount - testimonials.length} testimonial slot(s) per variant are placeholders. Replace them with real customer quotes before publishing.`);
    }
    addReview(output, { warnings });
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
