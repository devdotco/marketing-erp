-- Outbound Revenue writes to the erp.io CRM instead of GoHighLevel: record the CRM's own ids.
-- The ghl* columns stay (nothing reads them) so ids written before the move are not lost.
ALTER TABLE "OutboundProspect" ADD COLUMN "crmPersonId" TEXT;
ALTER TABLE "OutboundProspect" ADD COLUMN "crmDealId" TEXT;
