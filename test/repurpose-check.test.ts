/**
 * Checks for the Repurposer's deterministic output review (QA 2026-10-21).
 * Pure: no network, no database.
 */
import {
  applyThreadCounts,
  extractFigures,
  figureWarnings,
  urlWarnings,
  videoWarnings,
  xCharCount,
} from "@/lib/agents/repurpose-check";

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) failures += 1;
};

const source = "The market hit $2.69B in Q2 2026, up 20.55%. A study of 26K+ commits found 4% regressions. B2B buyers pay $30/month.";

// Figures
const w1 = figureWarnings({ video: { hook: "A $2.6 billion market" } }, source);
check("'$2.6 billion' is flagged against a source with $2.69B", w1.length === 1 && w1[0].includes("$2.6 billion"), w1);
const w2 = figureWarnings({ post: "A $2.69 billion market, or 2.69B" }, source);
check("'$2.69 billion' and '2.69B' are not flagged", w2.length === 0, w2);
const w3 = figureWarnings({ a: "Lovable went $6.6B to $13.3B; SpaceX paid $60B" }, source);
check("invented money figures are each flagged once", w3.length === 3, w3);
check("'26K+', '4%', '20.55%', 'Q2 2026', '$30/month' match the source", figureWarnings({ a: "26K+ commits, 4%, 20.55%, Q2 2026, $30/month" }, source).length === 0);
check("a drifted quarter is flagged", figureWarnings({ a: "In Q3 2026" }, source).length === 1);
check("'B2B' is not read as a figure", extractFigures("B2B and 2026 and 5 items").length === 0);
check("URLs do not produce figures", extractFigures("see https://x.com/a/2.69b/100%").length === 0);
const w4 = figureWarnings({ a: "Up 40% to $5M" }, "");
check("no source text: one warning that figures are unverifiable", w4.length === 1 && w4[0].includes("unverifiable"), w4);
check("no source text and no figures: nothing to warn", figureWarnings({ a: "No numbers here" }, "").length === 0);

// Video pacing
const fast = { totalSeconds: 30, scenes: [
  { seconds: 0, script: Array(28).fill("word").join(" ") },
  { seconds: 8, script: "slow and steady words here now" },
  { seconds: 24, script: "Read the full piece at the link below" },
] };
const vw = videoWarnings(fast, 30);
check("28 words in 8s is flagged as too fast", vw.some((w) => w.includes("scene 1") && w.includes("28 words in 8s")), vw);
check("slow scenes are not flagged", !vw.some((w) => w.includes("scene 2") || w.includes("scene 3")), vw);
const ok = videoWarnings({ totalSeconds: 30, scenes: [{ seconds: 0, script: "a b c d e f g h i j" }, { seconds: 6, script: "a b c d e f g h i j k l m n o" }, { seconds: 22, script: "Read it now" }] }, 30);
check("a well-paced, tiled script has no warnings", ok.length === 0, ok);
check("scenes that stop short of the end are flagged", videoWarnings({ totalSeconds: 30, scenes: [{ seconds: 0, script: "hi" }, { seconds: 10, script: "hi" }] }, 30).some((w) => w.includes("closing scene")));
check("scenes not starting at 0 are flagged", videoWarnings({ totalSeconds: 30, scenes: [{ seconds: 2, script: "hi" }, { seconds: 25, script: "hi" }] }, 30).some((w) => w.includes("not 0s")));
check("out-of-order scenes are flagged", videoWarnings({ totalSeconds: 30, scenes: [{ seconds: 0, script: "hi" }, { seconds: 12, script: "hi" }, { seconds: 10, script: "hi" }] }, 30).some((w) => w.includes("not after")));
check("a wrong totalSeconds is flagged", videoWarnings({ totalSeconds: 20, scenes: [{ seconds: 0, script: "hi" }, { seconds: 15, script: "hi" }] }, 30).some((w) => w.includes("20s")));

// X counting
const url = "https://dev.co/blog/ai-killed-white-label-web-development";
check("a URL counts as 23 characters", xCharCount(`Read it: ${url}`) === 9 + 23, xCharCount(`Read it: ${url}`));
check("emoji count as one character", xCharCount("a😀b") === 3);
const thread: Record<string, unknown> = {
  hook: "Short hook",
  posts: [{ text: "Short hook", charCount: 999 }, { text: "x".repeat(281), charCount: 5 }, { text: `Read: ${url}`, charCount: 1 }],
  totalPosts: 12,
};
const tw = applyThreadCounts(thread);
const posts = thread.posts as Array<{ charCount: number }>;
check("model counts are overwritten", posts[0].charCount === 10 && posts[2].charCount === 6 + 23, posts);
check("hook gets a charCount", thread.hookCharCount === 10, thread.hookCharCount);
check("totalPosts comes from the array", thread.totalPosts === 3);
check("only the over-limit post warns", tw.length === 1 && tw[0].includes("post 2"), tw);

// URLs
const src = "https://dev.co/blog/ai-killed-white-label-web-development";
const uw = urlWarnings({ x: { posts: [{ text: "Read https://dev.co/blog/ai-killed-white-label-development." }] } }, src, "article text");
check("a reconstructed URL is flagged", uw.length === 1, uw);
check("the supplied URL (with trailing punctuation/slash) passes", urlWarnings({ a: `Read ${src}/.` }, src, "").length === 0);
check("a URL quoted in the source text is ignored", urlWarnings({ a: "see https://example.com/study" }, src, "per https://example.com/study we found").length === 0);
check("no source URL: nothing to compare", urlWarnings({ a: "https://x.com/y" }, "", "").length === 0);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
