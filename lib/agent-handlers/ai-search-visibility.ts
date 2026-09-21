import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs, num } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { withProvenance } from "@/lib/agents/provenance";
import { ENGINE_NAMES } from "@/lib/answer-engines";
import { captureVisibility } from "@/lib/visibility/capture";
import { addPrompts, suggestPrompts } from "@/lib/visibility/prompts";
import { METRICS } from "@/lib/visibility/observations";
import {
  citationAuthority,
  deltaOf,
  readSeries,
  shareOfVoice,
  visibilityByEngine,
} from "@/lib/visibility/series";

/**
 * AI Search Visibility — what the engines actually say about this brand.
 *
 * This handler used to simulate. It sent one Haiku call asking the model to
 * imagine how ChatGPT, Perplexity, Gemini and Claude *would* answer and
 * whether the brand *would* be cited, then returned a citation-share
 * percentage built entirely out of that guess — alongside real Search Console
 * figures, in the same object, distinguished only by a `source` field nothing
 * rendered. A customer comparing us to a product that captures real answers
 * would have found that in about a minute.
 *
 * It now asks the engines. Every figure below comes from a stored
 * AnswerCapture (lib/visibility/capture.ts); the only model judgement in the
 * output is the `recommendations` block, which is labelled as such and carries
 * no numbers of its own.
 *
 * With no engine connected it refuses, and that refusal is the feature. The
 * alternative — producing a plausible number anyway — is exactly what was
 * wrong before.
 */
export const aiSearchVisibilityHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const workspaceId = run.agentConfig.workspaceId;
  const config = resolveInputs(run);
  const windowDays = num(config, "windowDays", 30, { min: 7, max: 180 });
  const autoSuggest = config.autoSuggestPrompts !== false;

  let costUsd = 0;
  let seeded: { added: number; groundedInSearchConsole: boolean } | null = null;

  // A workspace that has never set prompts up cannot be measured, and making
  // its first run a dead end is a poor trade when we can propose a list from
  // its own Search Console demand. Seeding is one-time: it only fires when
  // there are no prompts at all, never on top of a list someone curated.
  //
  // And only when a PERSON started the run. This agent used to be a single
  // cheap model call; it is now twenty prompts against every connected engine.
  // Any workspace that already had it enabled on a schedule would otherwise
  // wake up to a recurring daily spend on its own key that nobody chose —
  // seeded, scheduled and invisible until the provider invoice. A scheduled
  // run against an empty prompt list refuses instead, which is legible and
  // costs nothing.
  const startedByAPerson = run.triggeredBy !== "schedule";

  if (autoSuggest && startedByAPerson) {
    const existing = await prisma.trackedPrompt.count({ where: { workspaceId, active: true } });
    if (existing === 0) {
      const suggested = await suggestPrompts(workspaceId, { count: 20 });
      costUsd += suggested.costUsd;
      if (suggested.suggestions.length > 0) {
        const added = await addPrompts(workspaceId, suggested.suggestions);
        seeded = { added, groundedInSearchConsole: suggested.groundedInSearchConsole };
      }
    }
  }

  const capture = await captureVisibility(workspaceId, { runId: run.id });
  costUsd += capture.costUsd;

  // ── Everything below is read back out of the store, not held in memory from
  // the capture above. That is deliberate: it proves the figures the report
  // shows are the same ones the dashboard will show tomorrow.
  const [overall, rank, sentiment, byEngine, voice, authority] = await Promise.all([
    readSeries(workspaceId, { subject: "brand", metric: METRICS.VISIBILITY, days: windowDays }),
    readSeries(workspaceId, { subject: "brand", metric: METRICS.BRAND_RANK, days: windowDays }),
    readSeries(workspaceId, { subject: "brand", metric: METRICS.SENTIMENT, days: windowDays }),
    visibilityByEngine(workspaceId, windowDays),
    shareOfVoice(workspaceId, windowDays),
    citationAuthority(workspaceId, { days: windowDays, limit: 15 }),
  ]);

  const visibility = deltaOf(overall);
  const ahead = voice.filter((v) => !v.isBrand && v.value > (visibility.latest ?? 0));

  const measured = {
    capturedOn: capture.day,
    enginesMeasured: capture.engines.map((e) => ENGINE_NAMES[e]),
    promptsTracked: capture.prompts,
    capturesTaken: capture.captured,
    ...(capture.skippedPrompts > 0
      ? {
          promptsNotAsked: capture.skippedPrompts,
          promptsNotAskedNote:
            "Beyond the per-run cap. They stay tracked; raise the cap or pause some prompts if you want them measured.",
        }
      : {}),
    visibility: {
      latestPct: visibility.latest,
      changePct: visibility.change,
      daysOfHistory: visibility.samples,
      byEngine: byEngine.map((e) => ({
        engine: ENGINE_NAMES[e.engine as keyof typeof ENGINE_NAMES] ?? e.engine,
        visibilityPct: e.value,
      })),
      trend: overall.points,
    },
    positioning: {
      meanRankWhenMentioned: deltaOf(rank).latest,
      sentimentScore: deltaOf(sentiment).latest,
      sentimentScale: "1 = recommended, 0 = named neutrally, -1 = criticised",
    },
    shareOfVoice: voice.map((v) => ({
      name: v.isBrand ? "You" : v.subject,
      visibilityPct: v.value,
      isYou: v.isBrand,
    })),
    citationSources: authority.map((a) => ({
      domain: a.domain,
      citations: a.citations,
      isYourSite: a.isOwned,
    })),
    failures: capture.failures.map((f) => ({
      engine: ENGINE_NAMES[f.engine],
      prompt: f.prompt,
      error: f.error,
    })),
  };

  // The one model call left, and it produces no figures — only what to do
  // about the figures above. Kept separate in the output so the distinction
  // survives into the UI.
  const { client } = await resolveAnthropic(workspaceId);
  const message = await client.messages.create({
    model: MODELS.standard,
    max_tokens: 2000,
    system: [
      "You advise on AI search visibility, reading measurements someone else took.",
      "Never restate a number as if you derived it, and never invent one that is not in the data given to you.",
      "Citation in AI answers follows from being cited by the sources those answers already trust, from content that answers the question directly, and from being a recognised entity in the category — not from keyword density.",
      "Be specific about which gap explains which figure. Say what to publish, where, and why it would change the number.",
      "Return ONLY valid JSON, no markdown fences.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          "Here are this week's measurements. Recommend what to do.",
          JSON.stringify(measured, null, 2),
          ahead.length > 0
            ? `Competitors currently ahead: ${ahead.map((a) => `${a.subject} (${a.value}%)`).join(", ")}`
            : "",
          "",
          "Return:",
          JSON.stringify({
            readingOfTheData: "Two or three sentences on what these figures say.",
            opportunities: [
              {
                area: "Cited sources | Content gap | Entity presence | Competitor position",
                action: "What to do, specifically.",
                why: "Which figure above this addresses.",
                effort: "low | medium | high",
              },
            ],
          }),
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });
  costUsd += estimateCostUsd(MODELS.standard, message.usage);

  let advice: Record<string, unknown>;
  try {
    const raw = textFrom(message);
    const match = raw.match(/\{[\s\S]+\}/);
    advice = match ? JSON.parse(match[0]) : { readingOfTheData: raw };
  } catch {
    advice = { readingOfTheData: textFrom(message) };
  }

  const output: Record<string, unknown> = {
    measured,
    recommendations: advice,
    recommendationsNote:
      "The recommendations are the model's judgement over the measurements above. The figures are not — every one comes from a stored answer capture.",
    ...(seeded
      ? {
          promptsSeeded: {
            added: seeded.added,
            basis: seeded.groundedInSearchConsole
              ? "Proposed from this site's own highest-impression non-branded Search Console queries."
              : "Proposed from the business profile. Connect Search Console for prompts grounded in demand you already have.",
          },
        }
      : {}),
    generatedAt: new Date().toISOString(),
  };

  withProvenance(
    output,
    "ai-search-visibility",
    [
      {
        source: "ANSWER_CAPTURE",
        detail: `${capture.engines.map((e) => ENGINE_NAMES[e]).join(", ")} · ${capture.prompts} prompts on ${capture.day}`,
        rows: capture.captured,
      },
    ],
    capture.failures.length > 0
      ? `${capture.failures.length} of ${capture.prompts * capture.engines.length} engine calls failed and are excluded from these figures.`
      : undefined,
  );

  const requireApproval = config.requireApproval === true;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};
