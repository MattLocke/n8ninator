import { access, chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { AppSettings, ApprovalMode, PublicSettings, ReasoningEffort } from "./types.js";

const stateHome = resolve(process.env.N8NINATOR_HOME ?? resolve(homedir(), ".n8ninator"));
const settingsPath = resolve(stateHome, "settings.json");

const defaultWorkspace = resolve(process.env.N8NINATOR_WORKSPACE ?? process.cwd());

export const DEFAULT_SETTINGS: AppSettings = {
  workspace: defaultWorkspace,
  ollamaUrl: "http://127.0.0.1:11434",
  model: "gpt-oss:20b",
  contextLength: 16384,
  temperature: 0.2,
  reasoningEffort: "medium",
  approvalMode: "ask",
  maxAgentSteps: 12,
  n8nMcp: {
    enabled: false,
    url: "http://127.0.0.1:5678/mcp-server/http",
    accessToken: "",
  },
};

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "ask" || value === "auto" || value === "read-only";
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high";
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function httpUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fallback;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

async function existingDirectory(path: unknown, fallback: string): Promise<string> {
  if (typeof path !== "string" || !path.trim()) return fallback;
  const resolved = resolve(path.trim());
  try {
    await access(resolved, constants.R_OK);
    return await realpath(resolved);
  } catch {
    return fallback;
  }
}

async function normalize(raw: Partial<AppSettings> | undefined, current: AppSettings = DEFAULT_SETTINGS): Promise<AppSettings> {
  const candidate = raw ?? {};
  const rawMcp = candidate.n8nMcp ?? current.n8nMcp;
  return {
    workspace: await existingDirectory(candidate.workspace, current.workspace),
    ollamaUrl: httpUrl(candidate.ollamaUrl, current.ollamaUrl),
    model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model.trim() : current.model,
    contextLength: Math.round(finiteNumber(candidate.contextLength, current.contextLength, 4096, 131072)),
    temperature: finiteNumber(candidate.temperature, current.temperature, 0, 2),
    reasoningEffort: isReasoningEffort(candidate.reasoningEffort) ? candidate.reasoningEffort : current.reasoningEffort,
    approvalMode: isApprovalMode(candidate.approvalMode) ? candidate.approvalMode : current.approvalMode,
    maxAgentSteps: Math.round(finiteNumber(candidate.maxAgentSteps, current.maxAgentSteps, 2, 30)),
    n8nMcp: {
      enabled: typeof rawMcp.enabled === "boolean" ? rawMcp.enabled : current.n8nMcp.enabled,
      url: httpUrl(rawMcp.url, current.n8nMcp.url),
      accessToken:
        typeof rawMcp.accessToken === "string" ? rawMcp.accessToken.trim() : current.n8nMcp.accessToken,
    },
  };
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Partial<AppSettings>;
    return await normalize(raw);
  } catch {
    return await normalize(undefined);
  }
}

export async function saveSettings(patch: Record<string, unknown>): Promise<AppSettings> {
  const current = await loadSettings();
  const rawN8n = typeof patch.n8nMcp === "object" && patch.n8nMcp !== null ? patch.n8nMcp as Record<string, unknown> : {};
  const nextN8n = {
    ...current.n8nMcp,
    ...rawN8n,
    accessToken:
      rawN8n.clearToken === true
        ? ""
        : typeof rawN8n.accessToken === "string" && rawN8n.accessToken.trim()
          ? rawN8n.accessToken.trim()
          : current.n8nMcp.accessToken,
  };
  const merged = await normalize({ ...current, ...patch, n8nMcp: nextN8n } as Partial<AppSettings>, current);
  await mkdir(dirname(settingsPath), { recursive: true, mode: 0o700 });
  await writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(settingsPath, 0o600);
  return merged;
}

export function publicSettings(settings: AppSettings): PublicSettings {
  return {
    ...settings,
    n8nMcp: {
      enabled: settings.n8nMcp.enabled,
      url: settings.n8nMcp.url,
      tokenConfigured: Boolean(settings.n8nMcp.accessToken),
    },
  };
}

export const SETTINGS_PATH = settingsPath;
