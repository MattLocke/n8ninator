import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { ApprovalBroker, runAgent } from "./agent.js";
import { N8nMcpManager } from "./mcp-manager.js";
import { getOllamaStatus, pullOllamaModel } from "./ollama.js";
import { loadSettings, publicSettings, saveSettings, SETTINGS_PATH } from "./settings.js";
import { MODEL_PRESETS, type AgentEvent, type ChatMessage } from "./types.js";

const projectRoot = resolve(process.cwd());
const publicRoot = resolve(projectRoot, "public");
const app = express();
const approvals = new ApprovalBroker();
const mcp = new N8nMcpManager();

app.disable("x-powered-by");
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "3mb" }));

app.get("/vendor/marked.js", (_request, response) => response.sendFile(resolve(projectRoot, "node_modules/marked/lib/marked.umd.js")));
app.get("/vendor/purify.js", (_request, response) => response.sendFile(resolve(projectRoot, "node_modules/dompurify/dist/purify.min.js")));
app.use(express.static(publicRoot, { extensions: ["html"] }));

app.get("/api/health", (_request, response) => response.json({ ok: true, app: "n8ninator", version: "0.2.0" }));

app.get("/api/status", async (_request, response, next) => {
  try {
    const settings = await loadSettings();
    const ollama = await getOllamaStatus(settings.ollamaUrl);
    response.json({
      app: { version: "0.2.0", settingsPath: SETTINGS_PATH },
      settings: publicSettings(settings),
      ollama,
      mcp: mcp.status(settings.n8nMcp.enabled),
      presets: MODEL_PRESETS,
    });
  } catch (error) { next(error); }
});

app.get("/api/settings", async (_request, response, next) => {
  try { response.json(publicSettings(await loadSettings())); }
  catch (error) { next(error); }
});

app.patch("/api/settings", async (request, response, next) => {
  try {
    const settings = await saveSettings(request.body as Record<string, unknown>);
    await mcp.close();
    response.json(publicSettings(settings));
  } catch (error) { next(error); }
});

app.get("/api/system-prompt", async (_request, response, next) => {
  try {
    const promptPath = resolve(process.env.N8NINATOR_PROMPT ?? resolve(projectRoot, "prompts/n8n-system.md"));
    response.type("text/plain").send(await readFile(promptPath, "utf8"));
  } catch (error) { next(error); }
});

app.post("/api/mcp/test", async (_request, response) => {
  const settings = await loadSettings();
  if (!settings.n8nMcp.enabled) {
    response.status(400).json({ ok: false, error: "Enable n8n MCP and save settings first.", status: mcp.status(false) });
    return;
  }
  try {
    await mcp.ensure(settings, true);
    response.json({ ok: true, status: mcp.status(true) });
  } catch (error) {
    response.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error), status: mcp.status(true) });
  }
});

app.post("/api/models/pull", async (request, response) => {
  const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
  if (!model || !/^[a-zA-Z0-9._:/-]+$/.test(model)) {
    response.status(400).json({ error: "A valid Ollama model name is required." });
    return;
  }
  const settings = await loadSettings();
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  response.status(200);
  response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.flushHeaders();
  const send = (value: Record<string, unknown>): void => { if (!response.writableEnded) response.write(`${JSON.stringify(value)}\n`); };
  try {
    await pullOllamaModel(settings.ollamaUrl, model, controller.signal, (progress) => send({ type: "progress", ...progress }));
    send({ type: "done", model });
  } catch (error) {
    if (!controller.signal.aborted) send({ type: "error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (!response.writableEnded) response.end();
  }
});

app.post("/api/approvals/:id", (request, response) => {
  const approved = request.body?.approved === true;
  const resolved = approvals.resolve(request.params.id, approved);
  if (!resolved) response.status(404).json({ ok: false, error: "Approval request is no longer pending." });
  else response.json({ ok: true, approved });
});

app.post("/api/chat", async (request, response) => {
  const history = Array.isArray(request.body?.messages) ? request.body.messages as ChatMessage[] : [];
  if (!history.some((message) => message.role === "user" && typeof message.content === "string" && message.content.trim())) {
    response.status(400).json({ error: "At least one user message is required." });
    return;
  }
  const settings = await loadSettings();
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  response.status(200);
  response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.flushHeaders();
  const send = (event: AgentEvent): void => {
    if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify(event)}\n`);
  };
  try {
    await runAgent({ settings, history, mcp, approvals, signal: controller.signal, send });
  } catch (error) {
    if (!controller.signal.aborted) send({ type: "error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (!response.writableEnded) response.end();
  }
});

app.get("*path", (_request, response) => response.sendFile(resolve(publicRoot, "index.html")));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  response.status(500).json({ error: message });
});

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const workspace = argument("--workspace");
  if (workspace) await saveSettings({ workspace });
  const settings = await loadSettings();
  const host = process.env.N8NINATOR_HOST ?? "127.0.0.1";
  const port = Number(argument("--port") ?? process.env.N8NINATOR_PORT ?? 3210);
  const server = app.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log(`\n  n8ninator is ready: ${url}`);
    console.log(`  Workspace: ${settings.workspace}`);
    console.log(`  Model: ${settings.model}\n`);
    if (!process.argv.includes("--no-open") && process.env.N8NINATOR_NO_OPEN !== "1" && process.platform === "darwin") {
      setTimeout(() => spawn("open", [url], { detached: true, stdio: "ignore" }).unref(), 350);
    }
  });
  const shutdown = async (): Promise<void> => {
    await mcp.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

if (process.env.NODE_ENV !== "test") void main();

export { app };
