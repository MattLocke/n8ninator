import type { AppSettings, ChatMessage, OllamaToolCall, ToolDefinition } from "./types.js";

export interface OllamaModel {
  name: string;
  model?: string;
  size: number;
  modified_at?: string;
}

export interface OllamaStatus {
  connected: boolean;
  version?: string;
  models: OllamaModel[];
  error?: string;
}

export interface StreamedAssistantMessage {
  role: "assistant";
  content: string;
  thinking: string;
  tool_calls: OllamaToolCall[];
  metrics: Record<string, unknown>;
}

function baseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

async function responseError(response: Response): Promise<Error> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json() as { error?: string };
    if (body.error) message = body.error;
  } catch { /* use HTTP status */ }
  return new Error(message);
}

async function consumeNdjson(response: Response, onValue: (value: Record<string, unknown>) => void): Promise<void> {
  if (!response.body) throw new Error("Response did not contain a stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onValue(JSON.parse(line) as Record<string, unknown>);
    if (done) break;
  }
  if (buffer.trim()) onValue(JSON.parse(buffer) as Record<string, unknown>);
}

export async function getOllamaStatus(ollamaUrl: string): Promise<OllamaStatus> {
  try {
    const [versionResponse, tagsResponse] = await Promise.all([
      fetch(`${baseUrl(ollamaUrl)}/api/version`, { signal: AbortSignal.timeout(3_000) }),
      fetch(`${baseUrl(ollamaUrl)}/api/tags`, { signal: AbortSignal.timeout(5_000) }),
    ]);
    if (!versionResponse.ok) throw await responseError(versionResponse);
    if (!tagsResponse.ok) throw await responseError(tagsResponse);
    const version = await versionResponse.json() as { version?: string };
    const tags = await tagsResponse.json() as { models?: OllamaModel[] };
    return { connected: true, version: version.version, models: tags.models ?? [] };
  } catch (error) {
    return { connected: false, models: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function pullOllamaModel(ollamaUrl: string, model: string, signal: AbortSignal, onProgress: (value: Record<string, unknown>) => void): Promise<void> {
  const response = await fetch(`${baseUrl(ollamaUrl)}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    signal,
  });
  if (!response.ok) throw await responseError(response);
  await consumeNdjson(response, onProgress);
}

function thinkSetting(settings: AppSettings): boolean | "low" | "medium" | "high" | undefined {
  if (/gpt-oss/i.test(settings.model)) return settings.reasoningEffort;
  if (/qwen3/i.test(settings.model)) return true;
  return undefined;
}

export async function streamOllamaChat(
  settings: AppSettings,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
  onThinking: (delta: string) => void,
  onContent: (delta: string) => void,
): Promise<StreamedAssistantMessage> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    tools,
    stream: true,
    keep_alive: "10m",
    options: {
      num_ctx: settings.contextLength,
      ...(/gpt-oss/i.test(settings.model) ? {} : { temperature: settings.temperature }),
    },
  };
  const think = thinkSetting(settings);
  if (think !== undefined) body.think = think;
  const response = await fetch(`${baseUrl(settings.ollamaUrl)}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await responseError(response);

  let content = "";
  let thinking = "";
  const toolCalls: OllamaToolCall[] = [];
  let metrics: Record<string, unknown> = {};
  await consumeNdjson(response, (chunk) => {
    const message = typeof chunk.message === "object" && chunk.message !== null ? chunk.message as Record<string, unknown> : {};
    if (typeof message.thinking === "string" && message.thinking) {
      thinking += message.thinking;
      onThinking(message.thinking);
    }
    if (typeof message.content === "string" && message.content) {
      content += message.content;
      onContent(message.content);
    }
    if (Array.isArray(message.tool_calls)) toolCalls.push(...message.tool_calls as OllamaToolCall[]);
    if (chunk.done === true) metrics = {
      totalDuration: chunk.total_duration,
      loadDuration: chunk.load_duration,
      promptTokens: chunk.prompt_eval_count,
      outputTokens: chunk.eval_count,
      doneReason: chunk.done_reason,
    };
  });
  return { role: "assistant", content, thinking, tool_calls: toolCalls, metrics };
}
