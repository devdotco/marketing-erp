-- Outbound Engine pipeline chaining (Scout -> Strategist -> Email/LinkedIn Outbound). Additive and
-- safe on existing rows: parentRunId is nullable, so every run created before this migration keeps
-- working unchanged with parentRunId = NULL. See lib/agent-handlers/chaining.ts.
ALTER TABLE "AgentRun" ADD COLUMN "parentRunId" TEXT;

-- At most one child run per agent per parent. Postgres treats NULL as distinct in a unique index,
-- so this constrains nothing for runs with no parent (the overwhelming majority, including every
-- pre-existing row) — only a second child for the same (parentRunId, agentConfigId) pair collides.
CREATE UNIQUE INDEX "AgentRun_parentRunId_agentConfigId_key" ON "AgentRun"("parentRunId", "agentConfigId");

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_parentRunId_fkey"
  FOREIGN KEY ("parentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
