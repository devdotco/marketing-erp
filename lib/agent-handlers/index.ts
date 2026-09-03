import type { AgentRun, AgentConfig } from "@prisma/client";
import { adCreativeHandler } from "./ad-creative";
import { aiSearchVisibilityHandler } from "./ai-search-visibility";
import { anomalyWatchHandler } from "./anomaly-watch";
import { attributionHandler } from "./attribution";
import { backlinkMonitorHandler } from "./backlink-monitor";
import { blogWriterHandler } from "./blog-writer";
import { captionsClipsHandler } from "./captions-clips";
import { communityHandler } from "./community";
import { competitorWatchHandler } from "./competitor-watch";
import { contentRefreshHandler } from "./content-refresh";
import { croExperimentsHandler } from "./cro-experiments";
import { digitalPrHandler } from "./digital-pr";
import { emailMarketingHandler } from "./email-marketing";
import { googleAdsHandler } from "./google-ads";
import { gscAnalystHandler } from "./gsc-analyst";
import { inboxResponderHandler } from "./inbox-responder";
import { internalLinkingHandler } from "./internal-linking";
import { keywordResearchHandler } from "./keyword-research";
import { landingPageCopyHandler } from "./landing-page-copy";
import { leadEnrichmentHandler } from "./lead-enrichment";
import { linkedinAdsHandler } from "./linkedin-ads";
import { linkedinEngagerHandler } from "./linkedin-engager";
import { linkedinPosterHandler } from "./linkedin-poster";
import { localSeoGbpHandler } from "./local-seo-gbp";
import { metaAdsHandler } from "./meta-ads";
import { metaPosterHandler } from "./meta-poster";
import { newsletterHandler } from "./newsletter";
import { onSitePublisherHandler } from "./on-site-publisher";
import { onboarderHandler } from "./onboarder";
import { operatorHandler } from "./operator";
import { outreachHandler } from "./outreach";
import { placementHandler } from "./placement";
import { podcastHandler } from "./podcast";
import { proposalHandler } from "./proposal";
import { prospectorHandler } from "./prospector";
import { rankTrackerHandler } from "./rank-tracker";
import { repurposerHandler } from "./repurposer";
import { reviewEngineHandler } from "./review-engine";
import { schemaHandler } from "./schema";
import { shortFormHandler } from "./short-form";
import { socialListeningHandler } from "./social-listening";
import { technicalAuditHandler } from "./technical-audit";
import { topicPlannerHandler } from "./topic-planner";
import { videoScriptHandler } from "./video-script";
import { weeklyReportHandler } from "./weekly-report";
import { xEngagerHandler } from "./x-engager";
import { xPosterHandler } from "./x-poster";
import { youtubeHandler } from "./youtube";
import { stubHandler } from "./stub";

export type AgentHandler = (
  run: AgentRun & { agentConfig: AgentConfig },
  updateStatus: (status: string, output?: Record<string, unknown>) => Promise<void>
) => Promise<{ output: Record<string, unknown>; costUsd: number }>;

const HANDLERS: Record<string, AgentHandler> = {
  "ad-creative": adCreativeHandler,
  "ai-search-visibility": aiSearchVisibilityHandler,
  "anomaly-watch": anomalyWatchHandler,
  "attribution": attributionHandler,
  "backlink-monitor": backlinkMonitorHandler,
  "blog-writer": blogWriterHandler,
  "captions-clips": captionsClipsHandler,
  "community": communityHandler,
  "competitor-watch": competitorWatchHandler,
  "content-refresh": contentRefreshHandler,
  "cro-experiments": croExperimentsHandler,
  "digital-pr": digitalPrHandler,
  "email-marketing": emailMarketingHandler,
  "google-ads": googleAdsHandler,
  "gsc-analyst": gscAnalystHandler,
  "inbox-responder": inboxResponderHandler,
  "internal-linking": internalLinkingHandler,
  "keyword-research": keywordResearchHandler,
  "landing-page-copy": landingPageCopyHandler,
  "lead-enrichment": leadEnrichmentHandler,
  "linkedin-ads": linkedinAdsHandler,
  "linkedin-engager": linkedinEngagerHandler,
  "linkedin-poster": linkedinPosterHandler,
  "local-seo-gbp": localSeoGbpHandler,
  "meta-ads": metaAdsHandler,
  "meta-poster": metaPosterHandler,
  "newsletter": newsletterHandler,
  "on-site-publisher": onSitePublisherHandler,
  "onboarder": onboarderHandler,
  "operator": operatorHandler,
  "outreach": outreachHandler,
  "placement": placementHandler,
  "podcast": podcastHandler,
  "proposal": proposalHandler,
  "prospector": prospectorHandler,
  "rank-tracker": rankTrackerHandler,
  "repurposer": repurposerHandler,
  "review-engine": reviewEngineHandler,
  "schema": schemaHandler,
  "short-form": shortFormHandler,
  "social-listening": socialListeningHandler,
  "technical-audit": technicalAuditHandler,
  "topic-planner": topicPlannerHandler,
  "video-script": videoScriptHandler,
  "weekly-report": weeklyReportHandler,
  "x-engager": xEngagerHandler,
  "x-poster": xPosterHandler,
  "youtube": youtubeHandler,
};

export function getHandler(agentSlug: string): AgentHandler {
  return HANDLERS[agentSlug] ?? stubHandler;
}
