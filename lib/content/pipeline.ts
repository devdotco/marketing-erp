import type Anthropic from "@anthropic-ai/sdk";
import type { Article } from "./article";
import type { ContentBrief } from "./brief";
import { draftArticle, repairArticle } from "./draft";
import { runQc, type QcResult } from "./qc";
import { planSources, type ResearchResult } from "./research";

export interface StageRecord {
  stage: string;
  detail: string;
  costUsd: number;
  ms: number;
}

export interface PipelineResult {
  article: Article;
  qc: QcResult;
  research: ResearchResult;
  /** The citation budget actually used, after the evidence capped it. */
  externalLinkBudget: number;
  stages: StageRecord[];
  costUsd: number;
  repairRounds: number;
}

export type ProgressReporter = (stage: string, detail: string) => Promise<void> | void;

/**
 * The brief, with its citation budget cut to what the evidence can support.
 *
 * Every external link has to be a different verified source, so the ceiling is
 * the number of sources the research pass actually returned. When research is
 * switched off, or returned nothing, that ceiling is zero and the piece is
 * written as unsourced reasoning — which is a legitimate article, unlike one
 * with an invented citation in it.
 */
function withEvidenceBudget(brief: ContentBrief, research: ResearchResult): ContentBrief {
  if (!research.searched) return { ...brief, externalLinkCount: 0 };
  const ceiling = Math.min(brief.externalLinkCount, research.sources.length);
  return ceiling === brief.externalLinkCount ? brief : { ...brief, externalLinkCount: ceiling };
}

/**
 * Brief in, article out, with every stage the agent's own page promises.
 *
 * The shape is dm-watcher's: research the sources before writing so claims are
 * bound to real pages, draft through a schema-checked tool call, scan the result
 * in code, and hand the defects back for repair. The loop keeps the best draft
 * it has seen rather than the last one, because a repair round can fix two
 * defects and introduce three.
 */
export async function writeArticle(
  client: Anthropic,
  brief: ContentBrief,
  onProgress: ProgressReporter = () => {},
): Promise<PipelineResult> {
  const stages: StageRecord[] = [];
  let costUsd = 0;

  const record = async (stage: string, detail: string, stageCost: number, startedAt: number) => {
    stages.push({ stage, detail, costUsd: stageCost, ms: Date.now() - startedAt });
    costUsd += stageCost;
    await onProgress(stage, detail);
  };

  // 1 ── Research and verify claims
  let startedAt = Date.now();
  await onProgress("Research and verify claims", brief.webResearch ? "Searching for citable sources…" : "Skipped: web research is off for this brief.");
  const research = await planSources(client, brief);
  await record(
    "Research and verify claims",
    research.searched
      ? `${research.sources.length} source(s) verified, ${research.claims.length} claim(s) bound to a page.`
      : "Skipped: web research is off for this brief.",
    research.costUsd,
    startedAt,
  );

  // The brief asks for N citations; the research pass decides how many are
  // actually available. Asking the writer for three links when two sources
  // exist produces either a fabricated URL or a source linked twice, and then
  // QC fails the draft for a shortfall nothing could have met. The budget is
  // whatever the evidence supports, and the run says so.
  const effective = withEvidenceBudget(brief, research);
  if (effective.externalLinkCount !== brief.externalLinkCount) {
    await onProgress(
      "Research and verify claims",
      `Link budget cut from ${brief.externalLinkCount} to ${effective.externalLinkCount}: that is how many distinct sources the search actually produced.`,
    );
  }

  // 2 ── Draft
  startedAt = Date.now();
  await onProgress("Draft the article", "Writing…");
  const drafted = await draftArticle(client, effective, research);
  let article = drafted.article;
  await record(
    "Draft the article",
    `${article.wordCount} words across ${article.sections.length} sections${drafted.rounds > 1 ? " (needed a second round: the first submission arrived empty)" : ""}.`,
    drafted.costUsd,
    startedAt,
  );

  // 3 ── Quality control
  startedAt = Date.now();
  let qc = runQc(article, effective);
  await record(
    "Quality control",
    qc.pass ? "Passed on the first draft." : `${qc.defects.length} defect(s) found.`,
    0,
    startedAt,
  );

  // 4 ── Repair
  let repairRounds = 0;
  let best = { article, qc };

  while (!qc.pass && repairRounds < brief.maxRepairRounds) {
    repairRounds += 1;
    startedAt = Date.now();
    await onProgress(`Repair round ${repairRounds}`, `Fixing ${qc.defects.length} defect(s)…`);

    const repaired = await repairArticle(client, effective, research, article, qc.defects);
    article = repaired.article;
    qc = runQc(article, effective);

    const improved = qc.defects.length < best.qc.defects.length;
    if (improved) best = { article, qc };

    await record(
      `Repair round ${repairRounds}`,
      qc.pass
        ? "All defects cleared."
        : `${qc.defects.length} defect(s) remain${improved ? "" : " — this round did not improve on the earlier draft, which is the one that will be kept"}.`,
      repaired.costUsd,
      startedAt,
    );
  }

  // A repair round can trade two defects for three. Ship the cleanest draft the
  // run actually produced, not whichever one happened to be last.
  if (best.qc.defects.length < qc.defects.length) {
    article = best.article;
    qc = best.qc;
  }

  return {
    article,
    qc,
    research,
    externalLinkBudget: effective.externalLinkCount,
    stages,
    costUsd,
    repairRounds,
  };
}
