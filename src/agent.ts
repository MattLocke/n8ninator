import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { reviewGoal, type GoalReview, type GoalReviewer, type ToolEvidence } from "./goal-review.js";
import { N8nMcpManager, mcpToolNeedsApproval } from "./mcp-manager.js";
import { streamOllamaChat } from "./ollama.js";
import { INSPECT_TOOL_RESULT_DEFINITION, INSPECT_TOOL_RESULT_NAME, ToolResultCache } from "./tool-result-cache.js";
import type { AgentEvent, AppSettings, ChatMessage, OllamaToolCall, ToolDefinition } from "./types.js";
import { auditWorkflowMutation, isAuditedWorkflowMutation, workflowIdForMutation, type WorkflowAudit } from "./workflow-auditor.js";
import { compactToolArguments, executeLocalTool, LOCAL_TOOL_DEFINITIONS, localToolNeedsApproval } from "./workspace-tools.js";

type EventWriter = (event: AgentEvent) => void;

export interface AgentDependencies {
  streamChat?: typeof streamOllamaChat;
  goalReviewer?: GoalReviewer;
  modelSilenceTimeoutMs?: number;
  modelActiveSilenceTimeoutMs?: number;
  modelHeartbeatMs?: number;
}

class ModelStallError extends Error {
  constructor(public readonly hadOutput: boolean, public readonly timeoutMs: number) {
    super(hadOutput
      ? `The local model stopped producing output for ${Math.round(timeoutMs / 1_000)} seconds.`
      : `The local model produced no output for ${Math.round(timeoutMs / 1_000)} seconds.`);
    this.name = "ModelStallError";
  }
}

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

function positiveDuration(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

async function executeTool(name: string, args: Record<string, unknown>, settings: AppSettings, mcp: N8nMcpManager, resultCache: ToolResultCache): Promise<string> {
  if (name === INSPECT_TOOL_RESULT_NAME) return resultCache.inspect(args);
  if (mcp.remoteName(name)) return await mcp.call(name, args);
  return await executeLocalTool(name, args, settings.workspace);
}

function completionFeedback(review: GoalReview): string {
  const missing = review.missing.length ? review.missing.map((item) => `- ${item}`).join("\n") : "- The requested outcome is not yet evidenced.";
  return `## Completion controller: continue working

Your previous response was a draft, not a final answer. The harness checked it against the user's goal and found unfinished work.

Review: ${review.summary}

Missing:
${missing}

Next action: ${review.nextAction || "Take the next concrete tool-backed step and verify it."}

Do not restate the plan or promise future work. Continue now using the available tools. Only produce another final response after the requested outcome is complete or you have a concrete blocker that requires the user.`;
}

async function streamWithWatchdog(options: {
  settings: AppSettings;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal: AbortSignal;
  send: EventWriter;
  step: number;
  streamChat: typeof streamOllamaChat;
  silenceTimeoutMs: number;
  activeSilenceTimeoutMs: number;
  heartbeatMs: number;
  onThinking: (delta: string) => void;
  onContent: (delta: string) => void;
}): Promise<Awaited<ReturnType<typeof streamOllamaChat>>> {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", abortFromCaller, { once: true });
  let hadOutput = false;
  let lastActivityAt = Date.now();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectStall: ((error: Error) => void) | undefined;

  const scheduleStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    const timeoutMs = hadOutput ? options.activeSilenceTimeoutMs : options.silenceTimeoutMs;
    stallTimer = setTimeout(() => {
      const error = new ModelStallError(hadOutput, timeoutMs);
      rejectStall?.(error);
      controller.abort(error);
    }, timeoutMs);
  };
  const activity = (): void => {
    lastActivityAt = Date.now();
    scheduleStall();
  };
  const output = (callback: (delta: string) => void, delta: string): void => {
    hadOutput = true;
    activity();
    callback(delta);
  };
  const stalled = new Promise<never>((_resolve, reject) => { rejectStall = reject; });
  const heartbeat = setInterval(() => {
    const quietMs = Date.now() - lastActivityAt;
    if (quietMs < options.heartbeatMs * 0.8) return;
    const quietSeconds = Math.max(1, Math.round(quietMs / 1_000));
    options.send({
      type: "status",
      message: hadOutput
        ? `Waiting for more model output… ${quietSeconds}s quiet`
        : `Waiting for first model output… ${quietSeconds}s elapsed`,
      step: options.step,
      waiting: true,
      quietSeconds,
    });
  }, options.heartbeatMs);
  scheduleStall();

  try {
    const streaming = options.streamChat(
      options.settings,
      options.messages,
      options.tools,
      controller.signal,
      (delta) => output(options.onThinking, delta),
      (delta) => output(options.onContent, delta),
      activity,
    );
    return await Promise.race([streaming, stalled]);
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    clearInterval(heartbeat);
    options.signal.removeEventListener("abort", abortFromCaller);
  }
}

export async function runAgent(options: {
  settings: AppSettings;
  history: ChatMessage[];
  mcp: N8nMcpManager;
  approvals: ApprovalBroker;
  signal: AbortSignal;
  send: EventWriter;
  dependencies?: AgentDependencies;
}): Promise<void> {
  const { settings, mcp, approvals, signal, send } = options;
  const streamChat = options.dependencies?.streamChat ?? streamOllamaChat;
  const goalReviewer = options.dependencies?.goalReviewer ?? reviewGoal;
  const silenceTimeoutMs = positiveDuration(
    options.dependencies?.modelSilenceTimeoutMs ?? process.env.N8NINATOR_MODEL_SILENCE_MS,
    120_000,
  );
  const activeSilenceTimeoutMs = positiveDuration(
    options.dependencies?.modelActiveSilenceTimeoutMs ?? process.env.N8NINATOR_MODEL_ACTIVE_SILENCE_MS,
    60_000,
  );
  const heartbeatMs = positiveDuration(
    options.dependencies?.modelHeartbeatMs ?? process.env.N8NINATOR_MODEL_HEARTBEAT_MS,
    10_000,
  );
  let mcpError = "";
  if (settings.n8nMcp.enabled) {
    send({ type: "status", message: "Connecting to n8n MCP…" });
    try { await mcp.ensure(settings); }
    catch (error) { mcpError = error instanceof Error ? error.message : String(error); }
  } else await mcp.ensure(settings);

  const resultCache = new ToolResultCache();
  const tools: ToolDefinition[] = [...LOCAL_TOOL_DEFINITIONS, INSPECT_TOOL_RESULT_DEFINITION, ...mcp.definitions()];
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
  let goalChecks = 0;
  let lastReview: GoalReview | undefined;
  const evidence: ToolEvidence[] = [];
  for (let step = 1; step <= settings.maxAgentSteps; step++) {
    if (signal.aborted) throw new Error("Generation stopped");
    let outputStarted = false;
    const announceOutput = (): void => {
      if (outputStarted) return;
      outputStarted = true;
      send({ type: "status", message: "Model output started.", step });
    };
    send({ type: "status", message: step === 1 ? "Reasoning locally…" : `Continuing agent step ${step}…`, step });
    let response: Awaited<ReturnType<typeof streamOllamaChat>> | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        response = await streamWithWatchdog({
          settings,
          messages,
          tools,
          signal,
          send,
          step,
          streamChat,
          silenceTimeoutMs,
          activeSilenceTimeoutMs,
          heartbeatMs,
          onThinking: (delta) => {
            announceOutput();
            send({ type: "thinking", delta, step });
          },
          onContent: (delta) => {
            announceOutput();
            combinedContent += delta;
            send({ type: "delta", delta, step });
          },
        });
        break;
      } catch (error) {
        if (!(error instanceof ModelStallError)) throw error;
        if (!error.hadOutput && attempt === 1) {
          send({ type: "status", message: "The local model stalled before responding. Restarting this step once…", step, retrying: true });
          continue;
        }
        const attempts = attempt === 2 ? " after two attempts" : "";
        const recovery = error.hadOutput
          ? "The partial response was preserved. Try again; if this repeats, restart Ollama or select a smaller model."
          : "Restart Ollama or select a smaller model, then try again.";
        throw new Error(`${error.message}${attempts} ${recovery}`);
      }
    }
    if (!response) throw new Error("The local model did not return a response.");
    finalMetrics = response.metrics;
    messages.push({
      role: "assistant",
      content: response.content,
      thinking: response.thinking,
      tool_calls: response.tool_calls,
    });
    if (!response.tool_calls.length) {
      goalChecks += 1;
      send({ type: "status", message: "Checking the original goal against completed work…", step });
      lastReview = await goalReviewer({
        settings,
        history: options.history,
        candidate: response.content,
        evidence,
        signal,
      });
      send({
        type: "goal_review",
        complete: lastReview.complete,
        blocked: lastReview.blocked,
        summary: lastReview.summary,
        missing: lastReview.missing,
        nextAction: lastReview.nextAction,
        source: lastReview.source,
        check: goalChecks,
        step,
      });
      if (lastReview.complete || lastReview.blocked) {
        send({
          type: "done",
          content: combinedContent.trim(),
          metrics: finalMetrics,
          steps: step,
          goalChecks,
          blocked: lastReview.blocked,
        });
        return;
      }
      combinedContent = "";
      send({ type: "content_reset", reason: "Goal review found unfinished work.", step });
      messages.push({ role: "system", content: completionFeedback(lastReview) });
      continue;
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
      let beforeDetails: string | undefined;
      const auditedMutation = Boolean(remoteName && isAuditedWorkflowMutation(remoteName));
      const detailsTool = auditedMutation ? mcp.exposedName("get_workflow_details") : undefined;
      const beforeWorkflowId = remoteName ? workflowIdForMutation(remoteName, args) : "";
      if (allowed && auditedMutation && detailsTool && beforeWorkflowId) {
        send({ type: "status", message: `QA auditor: capturing workflow ${beforeWorkflowId} before the change…`, step, auditing: true });
        try { beforeDetails = await mcp.call(detailsTool, { workflowId: beforeWorkflowId }); }
        catch { /* the post-mutation snapshot can still verify the requested state */ }
      }
      if (!allowed) {
        ok = false;
        result = `Tool call denied by ${settings.approvalMode === "read-only" ? "read-only mode" : "the user"}. Continue without making this change, or explain what approval is needed.`;
      } else {
        try { result = await executeTool(name, args, settings, mcp, resultCache); }
        catch (error) {
          ok = false;
          result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      let audit: WorkflowAudit | undefined;
      if (ok && remoteName && auditedMutation) {
        const workflowId = workflowIdForMutation(remoteName, args, result);
        let afterDetails: string | undefined;
        if (detailsTool && workflowId) {
          send({ type: "status", message: `QA auditor: re-reading workflow ${workflowId} from n8n…`, step, auditing: true });
          try { afterDetails = await mcp.call(detailsTool, { workflowId }); }
          catch { /* represented as a failed audit below */ }
        }
        audit = auditWorkflowMutation({
          remoteName,
          arguments: args,
          mutationResult: result,
          beforeDetails,
          afterDetails,
        });
        send({
          type: "mutation_audit",
          passed: audit.passed,
          workflowId: audit.workflowId,
          summary: audit.summary,
          checks: audit.checks,
          failures: audit.failures,
          beforeVersion: audit.beforeVersion,
          afterVersion: audit.afterVersion,
          step,
        });
        const findings = [...audit.checks.map((check) => `PASS: ${check}`), ...audit.failures.map((failure) => `FAIL: ${failure}`)];
        result = `${result}\n\n## Independent post-mutation QA\n${audit.summary}\n${findings.map((finding) => `- ${finding}`).join("\n")}\n\n${audit.passed ? "The saved n8n state independently confirms this mutation." : "Do not claim this workflow was updated. Correct the mutation or report that QA could not verify it."}`;
      }
      const prepared = name === INSPECT_TOOL_RESULT_NAME
        ? { content: result, cached: false, originalLength: result.length }
        : resultCache.prepare(result, displayName);
      if (prepared.cached) {
        send({
          type: "status",
          message: `Large ${displayName} result cached (${prepared.originalLength.toLocaleString()} characters). Inspecting only relevant chunks…`,
          step,
          contextManaged: true,
          resultHandle: prepared.id,
        });
      }
      send({ type: "tool_result", tool: displayName, ok, result: preview(prepared.content), step, cached: prepared.cached, resultHandle: prepared.id });
      evidence.push({ tool: displayName, ok: ok && (audit?.passed ?? true), arguments: compactToolArguments(args), result: preview(prepared.content) });
      if (audit) evidence.push({
        tool: `QA · ${remoteName}`,
        ok: audit.passed,
        arguments: { workflowId: audit.workflowId, beforeVersion: audit.beforeVersion, afterVersion: audit.afterVersion },
        result: preview(`${audit.summary}\n${[...audit.checks, ...audit.failures].join("\n")}`),
      });
      messages.push({ role: "tool", tool_name: name, content: prepared.content });
    }
  }
  const unresolved = lastReview?.missing.length ? ` Still missing: ${lastReview.missing.join("; ")}` : "";
  throw new Error(`Agent reached the ${settings.maxAgentSteps}-step safety limit before the goal check passed.${unresolved} Continue with a narrower task or raise the step limit.`);
}
