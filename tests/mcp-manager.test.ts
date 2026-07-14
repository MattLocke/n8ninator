import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { N8nMcpManager, mcpToolNeedsApproval } from "../src/mcp-manager.js";
import type { AppSettings } from "../src/types.js";

function mockServer() {
  const server = new McpServer({ name: "mock-n8n", version: "1.0.0" });
  server.registerTool("search_workflows", {
    description: "Search mock workflows",
    inputSchema: { query: z.string().optional() },
  }, async ({ query }) => ({ content: [{ type: "text", text: `found:${query ?? "all"}` }] }));
  server.registerTool("create_workflow_from_code", {
    description: "Create a mock workflow",
    inputSchema: { code: z.string() },
  }, async () => ({ content: [{ type: "text", text: "created" }] }));
  return server;
}

test("n8n MCP manager discovers tools, sends bearer auth, and calls tools", async (t) => {
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  app.post("/mcp-server/http", async (request, response) => {
    if (request.headers.authorization !== "Bearer test-token") return response.status(401).json({ error: "unauthorized" });
    const server = mockServer();
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
    model: "gpt-oss:20b",
    contextLength: 8192,
    temperature: 0.2,
    reasoningEffort: "medium",
    approvalMode: "ask",
    maxAgentSteps: 6,
    n8nMcp: { enabled: true, url: `http://127.0.0.1:${port}/mcp-server/http`, accessToken: "test-token" },
  };
  const manager = new N8nMcpManager();
  t.after(async () => await manager.close());
  await manager.ensure(settings);
  assert.equal(manager.status(true).connected, true);
  assert.deepEqual(manager.status(true).toolNames, ["create_workflow_from_code", "search_workflows"]);
  assert.ok(manager.definitions().some((tool) => tool.function.name === "n8n_search_workflows"));
  assert.equal(await manager.call("n8n_search_workflows", { query: "broken" }), "found:broken");
  assert.equal(mcpToolNeedsApproval("search_workflows"), false);
  assert.equal(mcpToolNeedsApproval("validate_workflow"), false);
  assert.equal(mcpToolNeedsApproval("create_workflow_from_code"), true);
  assert.equal(mcpToolNeedsApproval("execute_workflow"), true);
});
