import { prisma } from "@/lib/prisma";

/**
 * How long a captured answer's full text is kept.
 *
 * The text is kept at all because every metric is derived from it and
 * derivations get corrected — a fix to brand matching should be re-appliable
 * to history rather than only to captures taken after the fix. That argument
 * has a shelf life: a correction is worth running over the last quarter, not
 * over three years.
 *
 * The arithmetic is the other half. A hundred prompts on four engines is four
 * hundred answers a day; at roughly 6 KB of text each that is ~2.4 MB a day,
 * ~875 MB a year, per workspace. These boxes have filled their disks before,
 * and a full disk here does not fail loudly — it failed a migration silently
 * once and the app served for hours with a missing column.
 *
 * So the row, its derived metrics and its citations are kept forever, and only
 * the prose is dropped. Every chart in the product keeps working on a pruned
 * day; what is lost is the ability to re-derive that day from scratch.
 */
export const ANSWER_TEXT_RETENTION_DAYS = 120;

/** Placeholder left behind, so a pruned answer is legibly pruned, not empty. */
const PRUNED = "[answer text pruned — see ANSWER_TEXT_RETENTION_DAYS]";

/**
 * Drop answer prose older than the retention window.
 *
 * Returns how many rows were pruned. Cheap and idempotent: already-pruned
 * rows are excluded by the text check, so running it on every capture costs
 * one indexed update that usually matches nothing.
 */
export async function pruneAnswerText(
  workspaceId: string,
  days = ANSWER_TEXT_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);

  const { count } = await prisma.answerCapture.updateMany({
    where: {
      workspaceId,
      capturedAt: { lt: cutoff },
      NOT: { answerText: PRUNED },
    },
    data: { answerText: PRUNED },
  });
  return count;
}

/** True when a capture's prose has been dropped, for the UI to say so. */
export function isPruned(answerText: string): boolean {
  return answerText === PRUNED;
}
