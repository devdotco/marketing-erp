import type { AgentHandler } from "./index";

export const stubHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Simulate work
  await new Promise((r) => setTimeout(r, 2000));

  const output = {
    message: `Stub handler ran for agent config ${run.agentConfigId}`,
    timestamp: new Date().toISOString(),
    note: "This agent is not yet implemented. Configure a real handler.",
  };

  return { output, costUsd: 0 };
};
