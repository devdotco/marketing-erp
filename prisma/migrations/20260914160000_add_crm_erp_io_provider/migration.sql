-- erp.io CRM (app.erp.io/crm) joins Mailchimp/Klaviyo/Instantly/Apollo as an
-- Email Marketing delivery channel. Connected with a per-tenant API key
-- created in that CRM (never a shared/global secret) — see
-- lib/integrations/crm-erp-io.ts and lib/integrations/verify/crm.ts.
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'CRM_ERP_IO';
