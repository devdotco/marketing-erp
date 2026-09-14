import type { Article, ImageBlock } from "@/lib/content/article";
import { allImageBlocks } from "@/lib/content/article";
import type { ContentBrief } from "@/lib/content/brief";
import { resolveImageProvider } from "./resolve";
import { saveGeneratedAsset } from "./store";

/** Hard ceiling regardless of what a run asks for — a runaway prompt should not write an unbounded row. */
const MAX_BYTES_PER_IMAGE = 8 * 1024 * 1024;

export interface GeneratedImageRecord {
  blockId: string;
  assetId: string;
  mimeType: string;
  sizeBytes: number;
  costUsd?: number;
}

export interface SkippedImage {
  blockId: string;
  reason: string;
}

export interface GenerateArticleImagesResult {
  connected: boolean;
  providerKind?: "OPENAI_IMAGES" | "GOOGLE_IMAGES";
  generated: GeneratedImageRecord[];
  skipped: SkippedImage[];
  totalCostUsd: number;
}

/**
 * Turn an article's `image` blocks into real files, after QC has passed.
 *
 * Cost control, in order:
 *  1. Called once, after QC passes — never per repair round. A repair round
 *     can run 0-4 times; generating on every round would multiply image spend
 *     by however many rounds a draft needed for reasons that have nothing to
 *     do with its images.
 *  2. Capped at brief.maxImages (hero first, then inline in document order —
 *     see article.ts's ImageBlock.slot). Anything over the cap is skipped
 *     with a reason, not silently dropped.
 *  3. One image = one provider call. A failure on one image is recorded and
 *     skipped; it does not fail the run or block the others.
 *
 * Not connected: returns immediately with `connected: false` and every block
 * skipped with that reason — the article still has its image BRIEFS (prompt +
 * alt text) in the body as a placeholder, which is the existing
 * includeImageBriefs behaviour, now also true for image blocks with no
 * provider to render them.
 */
export async function generateArticleImages(args: {
  workspaceId: string;
  runId: string;
  article: Article;
  brief: ContentBrief;
}): Promise<GenerateArticleImagesResult> {
  const { workspaceId, runId, article, brief } = args;
  const blocks = allImageBlocks(article);
  if (blocks.length === 0) {
    return { connected: false, generated: [], skipped: [], totalCostUsd: 0 };
  }

  const status = await resolveImageProvider(workspaceId);
  if (!status.connected) {
    return {
      connected: false,
      generated: [],
      skipped: blocks.map((b) => ({
        blockId: b.id,
        reason: "No image provider connected for this workspace. The image brief (prompt and alt text) is on the run; connect OpenAI Images or Google Images under Settings → Integrations to generate the file.",
      })),
      totalCostUsd: 0,
    };
  }

  // Hero first, then inline in document order — same priority the QC over-cap
  // defect message promises ("cut to the N that matter most — the hero
  // first").
  const ordered = [...blocks].sort((a, b) => (a.slot === "hero" ? -1 : 0) - (b.slot === "hero" ? -1 : 0));
  const withinCap = ordered.slice(0, Math.max(0, brief.maxImages));
  const overCap = ordered.slice(Math.max(0, brief.maxImages));

  const generated: GeneratedImageRecord[] = [];
  const skipped: SkippedImage[] = overCap.map((b) => ({
    blockId: b.id,
    reason: `Over this run's image cap (${brief.maxImages}).`,
  }));
  let totalCostUsd = 0;

  for (const block of withinCap) {
    try {
      const prompt = buildImagePrompt(block, brief);
      const size = block.slot === "hero" ? "1536x1024" : "1024x1024";
      const result = await status.provider.generateImage({ prompt, size });

      if (result.bytes.byteLength > MAX_BYTES_PER_IMAGE) {
        skipped.push({
          blockId: block.id,
          reason: `Generated image was ${(result.bytes.byteLength / 1024 / 1024).toFixed(1)}MB, over the ${MAX_BYTES_PER_IMAGE / 1024 / 1024}MB cap. Not stored.`,
        });
        continue;
      }

      // No compression pass: no image-processing library (sharp, etc.) exists
      // anywhere in this project (grepped before writing this), and adding one
      // — sharp in particular is a heavy native-binary dependency — is a call
      // this task deliberately left to a human rather than making silently.
      // Bytes are stored exactly as the provider returned them.
      const asset = await saveGeneratedAsset({
        workspaceId,
        runId,
        mimeType: result.mimeType,
        bytes: result.bytes,
        alt: block.alt,
        prompt,
        costUsd: result.costUsd,
      });

      generated.push({
        blockId: block.id,
        assetId: asset.id,
        mimeType: result.mimeType,
        sizeBytes: result.bytes.byteLength,
        costUsd: result.costUsd,
      });
      if (result.costUsd) totalCostUsd += result.costUsd;
    } catch (err) {
      skipped.push({ blockId: block.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { connected: true, providerKind: status.provider.kind, generated, skipped, totalCostUsd };
}

/**
 * The prompt actually sent to the provider: the block's own prompt, the
 * article's topic, the workspace's brand/editorial style, and — the owner
 * decision this exists for — whatever the person running this article asked
 * for in free text at run time (brief.visualsRequest). Safety constraints are
 * restated here even though the writer was already told them (lib/content/
 * brief.ts's renderVisualsRules), because the model that wrote the block
 * prompt and the model generating the pixels are not the same call and this
 * is the one that actually touches an image API.
 */
export function buildImagePrompt(block: ImageBlock, brief: ContentBrief): string {
  return [
    block.prompt,
    `Context: an image for an article about "${brief.topicBrief || brief.targetKeyword}".`,
    brief.brandContext ? `Brand context: ${brief.brandContext}` : "",
    `Visual style: ${brief.imageStyle}.`,
    brief.visualsRequest ? `This run specifically asked for: ${brief.visualsRequest}` : "",
    "Do not depict any real, named, or identifiable person. No logos, brand marks, or trademarks. No readable text rendered in the image.",
  ]
    .filter(Boolean)
    .join("\n");
}
