import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { N8nMcpManager, mcpToolNeedsApproval } from "./mcp-manager.js";
import { streamOllamaChat } from "./ollama.js";
import type { AgentEvent, AppSettings, ChatMessage, OllamaToolCall, ToolDefinition } from "./types.js";
import { compactToolArguments, executeLocalTool, LOCAL_TOOL_DEFINITIONS, localToolNeedsApproval } from "./workspace-tools.js";

type EventWriter = (event: AgentEvent) => void;

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  abort: () => void;
}

export class ApprovalBroker {
  private pending = new Map<string, PendingApproval>();

  async request(name: string, args: Record<string, unknown>, send: EventWriter, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const id = randomUUID();
    send({ type: "approval_required", id, tool: name, arguments: compactToolArguments(args) });
    return await new Promise<boolean>((resolveDecision) => {
      const finish = (approved: boolean): void => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        signal.removeEventListener("abort", pending.abort);
        this.pending.delete(id);
        send({ type: "approval_resolved", id, approved });
        resolveDecision(approved);
      };
      const abort = (): void => finish(false);
      const timer = setTimeout(() => finish(false), 5 * 60_000);
      this.pending.set(id, { resolve: finish, timer, abort });
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  resolve(id: string, approved: boolean): boolean {
    const item = this.pending.get(id);
    if (!item) return false;
    item.resolve(approved);
    return true;
  }
}

function argumentsObject(call: OllamaToolCall): Record<string, unknown> {
  const args = call.function.arguments;
  if (typeof args === "object" && args !== null && !Array.isArray(args)) return args;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* handled below */ }
  }
  return {};
}

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-24)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 80_000) }));
}

function preview(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 2_000)}… (${value.length} chars)` : value;
}

async function systemPrompt(settings: AppSettings, mcp: N8nMcpManager): Promise<string> {
  const promptPath = resolve(process.env.N8NINATOR_PROMPT ?? resolve(process.cwd(), "prompts/n8n-system.md"));
  const base = await readFile(promptPath, "utf8");
  const status = mcp.status(settings.n8nMcp.enabled);
  const mcpContext = status.connected
    ? `Connected to n8n MCP at ${status.url}. Available remote tools: ${status.toolNames.join(", ")}.`
    : settings.n8nMcp.enabled
      ? `n8n MCP was configured but is not connected${status.error ? `: ${status.error}` : "."}`
      : "n8n MCP is not configured. Work only with local files and public documentation unless the user connects it.";
  return `${base}\n\n## Runtime context\n\n- Current date: ${new Date().toISOString().slice(0, 10)}\n- Active workspace: ${settings.workspace}\n- ${mcpContext}\n- Write/command approval mode: ${settings.approvalMode}\n- Model: ${settings.model}\n`;
}

function needsApproval(name: string, mcp: N8nMcpManager): boolean {
  if (localToolNeedsApproval(name)) return true;
  const remoteName = mcp.remoteName(name);
  return remoteName ? mcpToolNeedsApproval(remoteName) : false;
}

async function executeTool(name: string, args: Record<string, unknown>, settings: AppSettings, mcp: N8nMcpManager): Promise<string> {
  if (mcp.remoteName(name)) return await mcp.call(name, args);
  return await executeLocalTool(name, args, settings.workspace);
}

export async function runAgent(options: {
  settings: AppSettings;
  history: ChatMessage[];
  mcp: N8nMcpManager;
  approvals: ApprovalBroker;
  signal: AbortSignal;
  send: EventWriter;
}): Promise<void> {
  const { settings, mcp, approvals, signal, send } = options;
  let mcpError = "";
  if (settings.n8nMcp.enabled) {
    send({ type: "status", message: "Connecting to n8n MCP…" });
    try { await mcp.ensure(settings); }
    catch (error) { mcpError = error instanceof Error ? error.message : String(error); }
  } else await mcp.ensure(settings);

  const tools: ToolDefinition[] = [...LOCAL_TOOL_DEFINITIONS, ...mcp.definitions()];
  const messages: ChatMessage[] = [
    { role: "system", content: await systemPrompt(settings, mcp) },
    ...trimHistory(options.history),
  ];
  send({
    type: "status",
    message: mcpError ? `n8n MCP unavailable; continuing with workspace tools. ${mcpError}` : `Ready with ${tools.length} tools.`,
    model: settings.model,
  });

  let combinedContent = "";
  let finalMetrics: Record<string, unknown> = {};
  for (let step = 1; step <= settings.maxAgentSteps; step++) {
    if (signal.aborted) throw new Error("Generation stopped");
    let thinkingStarted = false;
    send({ type: "status", message: step === 1 ? "Reasoning locally…" : `Continuing agent step ${step}…`, step });
    const response = await streamOllamaChat(
      settings,
      messages,
      tools,
      signal,
      (delta) => {
        if (!thinkingStarted) {
          thinkingStarted = true;
          send({ type: "status", message: "Reasoning locally…", step });
        }
        send({ type: "thinking", delta, step });
      },
      (delta) => {
        combinedContent += delta;
        send({ type: "delta", delta, step });
      },
    );
    finalMetrics = response.metrics;
    messages.push({
      role: "assistant",
      content: response.content,
      thinking: response.thinking,
      tool_calls: response.tool_calls,
    });
    if (!response.tool_calls.length) {
      send({ type: "done", content: combinedContent.trim(), metrics: finalMetrics, steps: step });
      return;
    }

    for (const call of response.tool_calls) {
      if (signal.aborted) throw new Error("Generation stopped");
      const name = call.function.name;
      const args = argumentsObject(call);
      const remoteName = mcp.remoteName(name);
      const displayName = remoteName ? `n8n · ${remoteName}` : name;
      send({ type: "tool_start", tool: displayName, arguments: compactToolArguments(args), step });

      let allowed = true;
      if (needsApproval(name, mcp)) {
        if (settings.approvalMode === "read-only") allowed = false;
        else if (settings.approvalMode === "ask") allowed = await approvals.request(displayName, args, send, signal);
      }

      let result: string;
      let ok = true;
      if (!allowed) {
        ok = false;
        result = `Tool call denied by ${settings.approvalMode === "read-only" ? "read-only mode" : "the user"}. Continue without making this change, or explain what approval is needed.`;
      } else {
        try { result = await executeTool(name, args, settings, mcp); }
        catch (error) {
          ok = false;
          result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      send({ type: "tool_result", tool: displayName, ok, result: preview(result), step });
      messages.push({ role: "tool", tool_name: name, content: result });
    }
  }
  throw new Error(`Agent reached the ${settings.maxAgentSteps}-step safety limit. Ask it to continue with a narrower task.`);
}
