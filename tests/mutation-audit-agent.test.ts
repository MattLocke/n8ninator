import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ApprovalBroker, runAgent } from "../src/agent.js";
import { N8nMcpManager } from "../src/mcp-manager.js";
import { streamOllamaChat } from "../src/ollama.js";
import type { AgentEvent, AppSettings, OllamaToolCall } from "../src/types.js";

test("agent retries an MCP update when independent post-mutation QA finds no saved change", async (t) => {
  let updateCalls = 0;
  const workflow: Record<string, unknown> = {
    id: "wf-qa",
    name: "QA workflow",
    versionId: "version-1",
    updatedAt: "2026-07-16T10:00:00.000Z",
    nodes: [{ name: "Transform", type: "n8n-nodes-base.set", parameters: { mode: "old" }, position: [0, 0] }],
    connections: {},
  };
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  app.post("/mcp-server/http", async (request, response) => {
    const server = new McpServer({ name: "mock-n8n-auditor", version: "1.0.0" });
    server.registerTool("get_workflow_details", {
      description: "Read workflow",
      inputSchema: { workflowId: z.string() },
    }, async () => ({ content: [{ type: "text", text: JSON.stringify({ workflow }) }] }));
    server.registerTool("update_workflow", {
      description: "Update workflow",
      inputSchema: { workflowId: z.string(), operations: z.array(z.any()) },
    }, async () => {
      updateCalls += 1;
      if (updateCalls === 2) {
        const node = (workflow.nodes as Array<Record<string, unknown>>)[0]!;
        node.parameters = { mode: "new" };
        workflow.versionId = "version-2";
        workflow.updatedAt = "2026-07-16T10:01:00.000Z";
      }
      return { content: [{ type: "text", text: JSON.stringify({ workflowId: "wf-qa", appliedOperations: 1 }) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
    response.on("close", () => { void transport.close(); void server.close(); });
  });
  app.get("/mcp-server/http", (_request, response) => response.status(405).end());
  app.delete("/mcp-server/http", (_request, response) => response.status(405).end());
  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise((resolveReady) => httpServer.once("listening", resolveReady));
  t.after(async () => await new Promise((resolveClosed) => httpServer.close(resolveClosed)));

  const port = (httpServer.address() as AddressInfo).port;
  const settings: AppSettings = {
    workspace: process.cwd(),
    ollamaUrl: "http://127.0.0.1:11434",
    model: "mock-model",
    contextLength: 8192,
    temperature: 0.2,
    reasoningEffort: "medium",
    approvalMode: "auto",
    maxAgentSteps: 6,
    n8nMcp: { enabled: true, url: `http://127.0.0.1:${port}/mcp-server/http`, accessToken: "" },
  };
  const manager = new N8nMcpManager();
  t.after(async () => await manager.close());
  const operation = { type: "setNodeParameter", nodeName: "Transform", path: "/mode", value: "new" };
  const toolCall: OllamaToolCall = { type: "function", function: { name: "n8n_update_workflow", arguments: { workflowId: "wf-qa", operations: [operation] } } };
  let modelCalls = 0;
  const streamChat: typeof streamOllamaChat = async (_settings, messages, _tools, _signal, _onThinking, onContent) => {
    modelCalls += 1;
    if (modelCalls === 1) return { role: "assistant", content: "", thinking: "", tool_calls: [toolCall], metrics: {} };
    const latestTool = [...messages].reverse().find((message) => message.role === "tool")?.content ?? "";
    if (modelCalls === 2) {
      assert.match(latestTool, /QA failed/i);
      assert.match(latestTool, /Do not claim this workflow was updated/i);
      return { role: "assistant", content: "", thinking: "", tool_calls: [toolCall], metrics: {} };
    }
    assert.match(latestTool, /QA passed/i);
    onContent("Updated and independently verified the workflow.");
    return { role: "assistant", content: "Updated and independently verified the workflow.", thinking: "", tool_calls: [], metrics: {} };
  };
  const events: AgentEvent[] = [];

  await runAgent({
    settings,
    history: [{ role: "user", content: "Change Transform mode to new in wf-qa." }],
    mcp: manager,
    approvals: new ApprovalBroker(),
    signal: new AbortController().signal,
    send: (event) => events.push(event),
    dependencies: {
      streamChat,
      goalReviewer: async (input) => {
        assert.ok(input.evidence.some((item) => item.tool === "QA · update_workflow" && item.ok === false));
        assert.ok(input.evidence.some((item) => item.tool === "QA · update_workflow" && item.ok === true));
        return { complete: true, blocked: false, summary: "The saved workflow matches the request.", missing: [], nextAction: "", source: "model" };
      },
    },
  });

  assert.equal(updateCalls, 2);
  assert.equal(modelCalls, 3);
  assert.deepEqual(events.filter((event) => event.type === "mutation_audit").map((event) => event.passed), [false, true]);
  assert.match(String(events.find((event) => event.type === "done")?.content), /independently verified/);
});
