import type { AgentRun, AgentConfig } from "@prisma/client";
import { blogWriterHandler } from "./blog-writer";
import { podcastHandler } from "./podcast";
import { technicalAuditHandler } from "./technical-audit";
import { stubHandler } from "./stub";

export type AgentHandler = (
  run: AgentRun & { agentConfig: AgentConfig },
  updateStatus: (status: string, output?: Record<string, unknown>) => Promise<void>
) => Promise<{ output: Record<string, unknown>; costUsd: number }>;

const HANDLERS: Record<string, AgentHandler> = {
  "blog-writer": blogWriterHandler,
  "podcast": podcastHandler,
  "technical-audit": technicalAuditHandler,
};

export function getHandler(agentSlug: string): AgentHandler {
  return HANDLERS[agentSlug] ?? stubHandler;
}
