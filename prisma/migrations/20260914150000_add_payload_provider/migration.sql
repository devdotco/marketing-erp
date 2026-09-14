-- Payload CMS joins WordPress/Storyblok/Webflow as an on-site publishing
-- target, and separately powers internal linking (reading a workspace's
-- existing published posts so the Blog Writer can link to them).
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'PAYLOAD';
