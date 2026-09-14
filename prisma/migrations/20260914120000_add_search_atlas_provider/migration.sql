-- SearchAtlas joins the SEO data providers (Ahrefs, Semrush) as a workspace
-- integration: topic ideas via its Topical Authority Map API and content-gap
-- keyword data via its Keyword Gap Analysis API.
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'SEARCH_ATLAS';
