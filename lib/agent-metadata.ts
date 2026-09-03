// Extended metadata for each agent: how-it-works steps, typed config inputs,
// outputs, and requirements. Populated by generate-agent-metadata workflow.
// Consumed by the agent detail page and configure form.

export interface AgentStep {
  title: string;
  detail: string;
}

export type InputType = "text" | "url" | "number" | "boolean" | "textarea" | "select";

export interface AgentInput {
  key: string;
  label: string;
  type: InputType;
  placeholder?: string;
  options?: string[];
  required?: boolean;
  defaultValue?: string;
  hint?: string;
}

export interface AgentMeta {
  overview: string;
  steps: AgentStep[];
  inputs: AgentInput[];
  outputs: string[];
  requirements: string[];
}

// Populated after workflow — keyed by agent slug
export const AGENT_META: Record<string, AgentMeta> = {};
