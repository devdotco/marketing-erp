-- Idempotency record for Instantly / Aimfox webhook deliveries (lib/webhooks/receive.ts). Additive:
-- a new, empty table; nothing existing reads or changes because of it.
-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_workspaceId_provider_dedupeKey_key" ON "WebhookReceipt"("workspaceId", "provider", "dedupeKey");

