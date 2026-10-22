/**
 * Regression checks for the Landing Page Copy QA findings (fabricated
 * testimonials, invented statistics, self-contradiction, absolute promises).
 * Pure: no network, no database.
 */
import {
  absoluteWarnings,
  buildSocialProof,
  contradictionWarnings,
  extractNumericClaims,
  finalizeVariants,
  parseTestimonials,
  unsupportedClaimWarnings,
  type Variant,
} from "@/lib/agents/claim-check";

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) failures += 1;
};

const v = (name: string, over: Variant = {}): Variant => ({
  name, headline: "", subheadline: "", heroBody: "", valueProps: [], objectionHandlers: [],
  cta: { primary: "Go", secondary: "See How" }, closingStatement: "", seo: { metaTitle: "", metaDescription: "" }, ...over,
});

const OFFER = "Custom software built for mid-market teams. Fixed-cost plan within 30 minutes of the scoping call.";

// Unsupported figures are flagged ...
const invented = v("proof-led", { heroBody: "We deliver 98% on-time across 300+ projects.", subheadline: "A 4.9/5 rating." });
const w = unsupportedClaimWarnings([invented], OFFER);
check("98% on-time flagged when absent", w.some((x) => x.includes('"98%"') && x.includes("proof-led") && x.includes("heroBody")), w);
check("300+ projects flagged when absent", w.some((x) => x.includes("300+ projects")), w);
check("4.9/5 flagged when absent", w.some((x) => x.includes("4.9/5")), w);

// ... and not flagged when supplied (300+ vs 300, spelled-out vs digits).
const supplied = OFFER + "\nWe have shipped 300 projects. 98% on-time delivery. Rated 4.9/5 by clients.";
check("supplied figures are not flagged", unsupportedClaimWarnings([invented], supplied).length === 0, unsupportedClaimWarnings([invented], supplied));
check("98% is not satisfied by a bare 98", unsupportedClaimWarnings([invented], OFFER + " 98 people").some((x) => x.includes('"98%"')));
const timing = v("outcome-led", { heroBody: "Get a fixed-cost plan in 30 minutes, then a ten-week build.", closingStatement: "A 30-minute call." });
const tw = unsupportedClaimWarnings([timing], OFFER);
check("30 minutes from the offer passes, ten-week build is flagged", tw.length === 1 && tw[0].includes("10-week"), tw);
check("bare structural numbers are ignored", extractNumericClaims("Step 1: talk. 3 steps. October 22.").length === 0, extractNumericClaims("Step 1: talk. 3 steps."));
check("placeholders are not claims", extractNumericClaims("[PROOF NEEDED: 12 client logos]").length === 0);
check("range borrows the unit", extractNumericClaims("in 4-6 weeks").some((c) => c.value === "4" && c.kind === "time"));

// Contradictions inside one variant.
const c = v("pain-led", { headline: "Trusted by 150+ teams", seo: { metaTitle: "", metaDescription: "Built for 300+ teams" } });
const cw = contradictionWarnings([c]);
check("150+ vs 300+ teams flagged", cw.length === 1 && cw[0].includes("team") && cw[0].includes("pain-led"), cw);
check("same figure twice is fine", contradictionWarnings([v("pain-led", { headline: "150+ teams", heroBody: "Join 150 teams." })]).length === 0);

// Absolutes.
const ab = v("pain-led", { heroBody: "You own the code. No exceptions. Your finance team is never surprised." });
const aw = absoluteWarnings([ab], OFFER);
check("no exceptions flagged with its sentence", aw.some((x) => x.includes("no exceptions") && x.includes("No exceptions.")), aw);
check("never flagged", aw.some((x) => x.includes('"never"')), aw);
check("absolute allowed when the offer makes it", absoluteWarnings([ab], OFFER + " You own the code, no exceptions. We never bill overruns.").length === 0);
check("100% is policed as an absolute, not as a statistic", unsupportedClaimWarnings([v("x", { heroBody: "100% yours" })], OFFER).length === 0 && absoluteWarnings([v("x", { heroBody: "Own 100% of the code" })], OFFER).length === 1);

// Testimonials.
const real = parseTestimonials('"Shipped on time and on budget." — Jane Roe, Acme Corp\nGreat team - Sam Lee, Beta LLC');
check("testimonials parse", real.length === 2 && real[0].author === "Jane Roe" && real[0].company === "Acme Corp" && real[0].quote === "Shipped on time and on budget." && real[1].company === "Beta LLC", real);
const proof = buildSocialProof("outcome-led", real.slice(0, 1), 3, ["a buyer who valued the handover", "call in 2 days"]);
check("one real, two placeholders", proof.length === 3 && !proof[0].placeholder && proof[1].placeholder && proof[2].placeholder, proof);
check("placeholder is built in code", proof[1].quote.startsWith("[Replace with a real customer quote about") && proof[1].author === "[Customer name]" && proof[1].sourceUrl === null, proof[1]);
check("model guidance used, digit-bearing guidance rejected", proof[1].guidance === "a buyer who valued the handover" && !/\d/.test(proof[2].guidance ?? ""), proof);

const base = { inputText: OFFER, testimonials: [], keyword: "custom software", wordCountTarget: 600, defaultSecondaryCta: "See How It Works" };
const modelV = v("pain-led", {
  headline: "Custom software without the surprises",
  socialProof: [{ quote: "hit it within 2%", author: "Made Up", company: "Fake Co" }],
  valuePropsNote: "", reviewNotes: ["", "Unsure about timeline"], cta: { primary: "Go", secondary: "" },
});
const warn = finalizeVariants([modelV], { ...base, socialProofCount: 2 });
const sp = modelV.socialProof as Array<{ placeholder: boolean; quote: string }>;
check("fabricated testimonial replaced and warned", sp.length === 2 && sp.every((p) => p.placeholder) && warn.some((x) => x.includes("not in your supplied list")), { sp, warn });
check("valuePropsNote removed, empty notes stripped", !("valuePropsNote" in modelV) && JSON.stringify(modelV.reviewNotes) === '["Unsure about timeline"]', modelV);
check("blank secondary CTA gets the default", (modelV.cta as { secondary: string }).secondary === "See How It Works");
const m = modelV.metrics as { keywordInH1: boolean; wordCount: number };
check("metrics computed", m.keywordInH1 === true && m.wordCount === 10, m);
check("word count outside 25% warns", warn.some((x) => x.includes("outside the 450-750")), warn);

const zero = v("proof-led", { socialProof: [{ quote: "x", author: "y", company: "z" }] });
finalizeVariants([zero], { ...base, socialProofCount: 0 });
check("socialProofCount 0 gives no socialProof", !("socialProof" in zero), zero);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
