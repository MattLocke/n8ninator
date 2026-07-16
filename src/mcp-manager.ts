import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppSettings, ToolDefinition } from "./types.js";

interface McpToolRecord {
  exposedName: string;
  remoteName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpStatus {
  enabled: boolean;
  connected: boolean;
  url: string;
  toolCount: number;
  toolNames: string[];
  error?: string;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function exposedToolName(remoteName: string): string {
  const normalized = `n8n_${remoteName}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized.length <= 64 ? normalized : `${normalized.slice(0, 53)}_${shortHash(remoteName)}`;
}

function mcpResultText(result: unknown): string {
  if (typeof result !== "object" || result === null) return JSON.stringify(result);
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const textParts: string[] = [];
  for (const item of content) {
    if (typeof item === "object" && item !== null) {
      const block = item as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
      else textParts.push(JSON.stringify(block));
    } else textParts.push(String(item));
  }
  const body = record.structuredContent !== undefined
    ? JSON.stringify(record.structuredContent)
    : textParts.join("\n") || JSON.stringify(record);
  return record.isError === true ? JSON.stringify({ isError: true, content: body }) : body;
}

export function mcpToolNeedsApproval(remoteName: string): boolean {
  return !/^(search_|get_|list_|validate_|explore_|read_|inspect_)/i.test(remoteName);
}

export class N8nMcpManager {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private tools = new Map<string, McpToolRecord>();
  private signature = "";
  private connecting?: Promise<void>;
  private lastError = "";
  private activeUrl = "";

  async ensure(settings: AppSettings, force = false): Promise<void> {
    const mcp = settings.n8nMcp;
    if (!mcp.enabled) {
      await this.close();
      this.activeUrl = mcp.url;
      return;
    }
    const nextSignature = shortHash(`${mcp.url}\0${mcp.accessToken}`);
    if (!force && this.client && this.signature === nextSignature && this.tools.size) return;
    if (this.connecting && !force) return await this.connecting;
    this.connecting = this.connect(settings, nextSignature).finally(() => { this.connecting = undefined; });
    return await this.connecting;
  }

  private async connect(settings: AppSettings, signature: string): Promise<void> {
    await this.close();
    const { url, accessToken } = settings.n8nMcp;
    this.activeUrl = url;
    this.lastError = "";
    try {
      const headers: Record<string, string> = { Accept: "application/json, text/event-stream" };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
      const client = new Client({ name: "n8ninator", version: "0.1.0" });
      await client.connect(transport);
      const response = await client.listTools();
      const records = new Map<string, McpToolRecord>();
      for (const tool of response.tools) {
        const exposedName = exposedToolName(tool.name);
        records.set(exposedName, {
          exposedName,
          remoteName: tool.name,
          description: tool.description ?? `Call the n8n MCP tool ${tool.name}`,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        });
      }
      this.client = client;
      this.transport = transport;
      this.tools = records;
      this.signature = signature;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.close(false);
      throw new Error(`n8n MCP connection failed: ${this.lastError}`);
    }
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      type: "function",
      function: {
        name: tool.exposedName,
        description: `[n8n MCP: ${tool.remoteName}] ${tool.description}`,
        parameters: tool.inputSchema,
      },
    }));
  }

  remoteName(exposedName: string): string | undefined {
    return this.tools.get(exposedName)?.remoteName;
  }

  exposedName(remoteName: string): string | undefined {
    return [...this.tools.values()].find((tool) => tool.remoteName === remoteName)?.exposedName;
  }

  async call(exposedName: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(exposedName);
    if (!tool || !this.client) throw new Error(`Unknown or disconnected n8n MCP tool: ${exposedName}`);
    const result = await this.client.callTool({ name: tool.remoteName, arguments: args });
    return mcpResultText(result);
  }

  status(enabled = true): McpStatus {
    const base: McpStatus = {
      enabled,
      connected: Boolean(this.client && this.tools.size),
      url: this.activeUrl,
      toolCount: this.tools.size,
      toolNames: [...this.tools.values()].map((tool) => tool.remoteName).sort(),
    };
    return this.lastError ? { ...base, error: this.lastError } : base;
  }

  async close(clearError = true): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.tools.clear();
    this.signature = "";
    if (clearError) this.lastError = "";
    try { await client?.close(); } catch { /* already disconnected */ }
    try { await transport?.close(); } catch { /* already disconnected */ }
  }
}
