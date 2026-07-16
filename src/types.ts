export type ApprovalMode = "ask" | "auto" | "read-only";
export type ReasoningEffort = "low" | "medium" | "high";

export interface N8nMcpSettings {
  enabled: boolean;
  url: string;
  accessToken: string;
}

export interface AppSettings {
  workspace: string;
  ollamaUrl: string;
  model: string;
  contextLength: number;
  temperature: number;
  reasoningEffort: ReasoningEffort;
  approvalMode: ApprovalMode;
  maxAgentSteps: number;
  n8nMcp: N8nMcpSettings;
}

export interface PublicSettings extends Omit<AppSettings, "n8nMcp"> {
  n8nMcp: Omit<N8nMcpSettings, "accessToken"> & {
    tokenConfigured: boolean;
  };
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  thinking?: string;
  tool_name?: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaToolCall {
  type?: "function";
  function: {
    index?: number;
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentEvent {
  type:
    | "status"
    | "thinking"
    | "delta"
    | "tool_start"
    | "tool_result"
    | "approval_required"
    | "approval_resolved"
    | "goal_review"
    | "mutation_audit"
    | "content_reset"
    | "done"
    | "error";
  [key: string]: unknown;
}

export interface ModelPreset {
  id: string;
  label: string;
  size: string;
  tier: "recommended" | "lean" | "stretch" | "not-recommended";
  description: string;
  defaultContext: number;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "gpt-oss:20b",
    label: "GPT-OSS 20B",
    size: "14 GB",
    tier: "recommended",
    description: "Best balance for a 24 GB Mac: strong reasoning and native tool use with usable memory headroom.",
    defaultContext: 16384,
  },
  {
    id: "qwen2.5-coder:14b",
    label: "Qwen2.5-Coder 14B",
    size: "9 GB",
    tier: "lean",
    description: "Faster and lighter code specialist. Use when multitasking or when the default model feels memory-constrained.",
    defaultContext: 16384,
  },
  {
    id: "devstral-small-2:24b",
    label: "Devstral Small 2 24B",
    size: "15 GB",
    tier: "stretch",
    description: "Strong 24B software-engineering model, but its 15 GB weights leave less unified-memory headroom on a 24 GB Mac.",
    defaultContext: 8192,
  },
  {
    id: "qwen3-coder:30b",
    label: "Qwen3-Coder 30B",
    size: "19 GB",
    tier: "not-recommended",
    description: "Very capable agentic coder, but too close to the 24 GB ceiling for consistently reliable use.",
    defaultContext: 8192,
  },
];
