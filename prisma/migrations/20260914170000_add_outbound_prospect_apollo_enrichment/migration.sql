-- The Outbound Strategist now enriches prospects from Apollo.io (organization + person +
-- job postings) before scoring, and caches what it fetched here so a later run within the
-- freshness window reuses it instead of re-spending an Apollo credit. Nullable: prospects
-- scored before this change, or scored with Apollo not connected, simply have none.
-- See lib/agent-handlers/outbound-strategist.ts.
ALTER TABLE "OutboundProspect" ADD COLUMN "apolloEnrichment" JSONB;
