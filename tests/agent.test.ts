import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ApprovalBroker, runAgent } from "../src/agent.js";
import { conservativeGoalReview, reviewGoal, type GoalReview, type GoalReviewer } from "../src/goal-review.js";
import { N8nMcpManager } from "../src/mcp-manager.js";
import { streamOllamaChat } from "../src/ollama.js";
import type { AgentEvent, AppSettings, OllamaToolCall } from "../src/types.js";

function settings(workspace: string): AppSettings {
  return {
    workspace,
    ollamaUrl: "http://127.0.0.1:11434",
    model: "mock-model",
    contextLength: 8192,
    temperature: 0.2,
    reasoningEffort: "medium",
    approvalMode: "auto",
    maxAgentSteps: 6,
    n8nMcp: { enabled: false, url: "http://127.0.0.1:5678/mcp-server/http", accessToken: "" },
  };
}

test("completion gate rejects a premature answer and resumes concrete work", async (t) => {
  const workspace = await mkdtemp(resolve(tmpdir(), "n8ninator-follow-through-"));
  const mcp = new N8nMcpManager();
  t.after(async () => { await mcp.close(); await rm(workspace, { recursive: true, force: true }); });

  const toolCall: OllamaToolCall = {
    type: "function",
    function: { name: "write_file", arguments: { path: "result.txt", content: "finished\n" } },
  };
  const responses = [
    { content: "I inspected the request and will create the file next.", tool_calls: [] as OllamaToolCall[] },
    { content: "", tool_calls: [toolCall] },
    { content: "Created `result.txt` and verified the write completed.", tool_calls: [] as OllamaToolCall[] },
  ];
  let chatCalls = 0;
  const streamChat: typeof streamOllamaChat = async (_settings, _messages, _tools, _signal, _onThinking, onContent) => {
    const response = responses[chatCalls++];
    assert.ok(response, "unexpected extra model call");
    if (response.content) onContent(response.content);
    return { role: "assistant", content: response.content, thinking: "", tool_calls: response.tool_calls, metrics: { outputTokens: 8 } };
  };

  const reviews: GoalReview[] = [
    {
      complete: false,
      blocked: false,
      summary: "The answer only promises the requested file.",
      missing: ["Create result.txt."],
      nextAction: "Call write_file now.",
      source: "model",
    },
    {
      complete: true,
      blocked: false,
      summary: "The requested file was created with successful tool evidence.",
      missing: [],
      nextAction: "",
      source: "model",
    },
  ];
  let reviewCalls = 0;
  const goalReviewer: GoalReviewer = async () => {
    const review = reviews[reviewCalls++];
    assert.ok(review, "unexpected extra completion review");
    return review;
  };

  const events: AgentEvent[] = [];
  await runAgent({
    settings: settings(workspace),
    history: [{ role: "user", content: "Create result.txt containing finished." }],
    mcp,
    approvals: new ApprovalBroker(),
    signal: new AbortController().signal,
    send: (event) => events.push(event),
    dependencies: { streamChat, goalReviewer },
  });

  assert.equal(await readFile(resolve(workspace, "result.txt"), "utf8"), "finished\n");
  assert.equal(chatCalls, 3);
  assert.equal(reviewCalls, 2);
  assert.equal(events.filter((event) => event.type === "content_reset").length, 1);
  assert.deepEqual(events.filter((event) => event.type === "goal_review").map((event) => event.complete), [false, true]);
  const done = events.find((event) => event.type === "done");
  assert.match(String(done?.content), /Created `result\.txt`/);
  assert.equal(done?.goalChecks, 2);
});

test("model watchdog reports silence and retries once before any output", async (t) => {
  const workspace = await mkdtemp(resolve(tmpdir(), "n8ninator-watchdog-"));
  const mcp = new N8nMcpManager();
  t.after(async () => { await mcp.close(); await rm(workspace, { recursive: true, force: true }); });

  let chatCalls = 0;
  const streamChat: typeof streamOllamaChat = async (_settings, _messages, _tools, signal, _onThinking, onContent) => {
    chatCalls += 1;
    if (chatCalls === 1) {
      return await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    onContent("Recovered after restarting the stalled request.");
    return { role: "assistant", content: "Recovered after restarting the stalled request.", thinking: "", tool_calls: [], metrics: {} };
  };
  const completeReview: GoalReviewer = async () => ({
    complete: true,
    blocked: false,
    summary: "The answer completed after recovery.",
    missing: [],
    nextAction: "",
    source: "model",
  });
  const events: AgentEvent[] = [];

  await runAgent({
    settings: settings(workspace),
    history: [{ role: "user", content: "Explain the workflow." }],
    mcp,
    approvals: new ApprovalBroker(),
    signal: new AbortController().signal,
    send: (event) => events.push(event),
    dependencies: {
      streamChat,
      goalReviewer: completeReview,
      modelSilenceTimeoutMs: 30,
      modelActiveSilenceTimeoutMs: 30,
      modelHeartbeatMs: 5,
    },
  });

  assert.equal(chatCalls, 2);
  assert.ok(events.some((event) => event.type === "status" && event.waiting === true));
  assert.ok(events.some((event) => event.type === "status" && event.retrying === true));
  assert.match(String(events.find((event) => event.type === "done")?.content), /Recovered/);
});

test("model watchdog preserves partial output instead of duplicating it", async (t) => {
  const workspace = await mkdtemp(resolve(tmpdir(), "n8ninator-partial-stall-"));
  const mcp = new N8nMcpManager();
  t.after(async () => { await mcp.close(); await rm(workspace, { recursive: true, force: true }); });

  let chatCalls = 0;
  const streamChat: typeof streamOllamaChat = async (_settings, _messages, _tools, signal, _onThinking, onContent) => {
    chatCalls += 1;
    onContent("Partial response");
    return await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const events: AgentEvent[] = [];

  await assert.rejects(runAgent({
    settings: settings(workspace),
    history: [{ role: "user", content: "Explain the workflow." }],
    mcp,
    approvals: new ApprovalBroker(),
    signal: new AbortController().signal,
    send: (event) => events.push(event),
    dependencies: {
      streamChat,
      modelSilenceTimeoutMs: 30,
      modelActiveSilenceTimeoutMs: 30,
      modelHeartbeatMs: 5,
    },
  }), /partial response was preserved/i);

  assert.equal(chatCalls, 1);
  assert.equal(events.filter((event) => event.type === "delta").length, 1);
  assert.equal(events.filter((event) => event.retrying === true).length, 0);
});

test("conservative goal review does not accept planning as action completion", () => {
  const actionReview = conservativeGoalReview({
    history: [{ role: "user", content: "Please update the workflow file." }],
    candidate: "I will inspect it and then make the change.",
    evidence: [],
  });
  assert.equal(actionReview.complete, false);
  assert.match(actionReview.nextAction, /concrete tool-backed step/);

  const answerReview = conservativeGoalReview({
    history: [{ role: "user", content: "How does n8n item linking work?" }],
    candidate: "Item linking preserves the relationship between input and output items.",
    evidence: [],
  });
  assert.equal(answerReview.complete, true);
});

test("exact file goals require deterministic verification before semantic review", async () => {
  const result = await reviewGoal({
    settings: settings(process.cwd()),
    history: [{ role: "user", content: "Create exact.txt containing exactly one line and a final newline." }],
    candidate: "Created the requested file.",
    evidence: [{ tool: "write_file", ok: true, arguments: { path: "exact.txt" }, result: '{"ok":true,"bytes":5}' }],
    signal: new AbortController().signal,
  });
  assert.equal(result.complete, false);
  assert.equal(result.source, "deterministic");
  assert.match(result.nextAction, /write_file_lines/);
});
