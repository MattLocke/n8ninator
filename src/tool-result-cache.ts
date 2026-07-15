import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "./types.js";

const MAX_INLINE_CHARS = 8_000;
const MAX_CACHED_CHARS = 2_000_000;
const MAX_ENTRIES = 8;
const DEFAULT_READ_CHARS = 8_000;
const MAX_READ_CHARS = 12_000;
const SEARCH_CONTEXT_CHARS = 500;
const MAX_SEARCH_MATCHES = 12;

interface CachedToolResult {
  content: string;
  originalLength: number;
  source: string;
  truncated: boolean;
}

export interface PreparedToolResult {
  content: string;
  cached: boolean;
  id?: string;
  originalLength: number;
}

export const INSPECT_TOOL_RESULT_NAME = "inspect_tool_result";

export const INSPECT_TOOL_RESULT_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: INSPECT_TOOL_RESULT_NAME,
    description: "Inspect a large result previously cached by the harness without loading all of it into model context. Search for a node name, ID, field, or expression first; use offset/limit only when sequential reading is necessary.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Cache handle shown in the large-result tool response." },
        query: { type: "string", description: "Optional case-insensitive literal search. Returns bounded matches with surrounding context." },
        offset: { type: "integer", minimum: 0, description: "Character offset for sequential reading. Defaults to 0 and is ignored when query is set." },
        limit: { type: "integer", minimum: 500, maximum: MAX_READ_CHARS, description: `Maximum characters to return. Defaults to ${DEFAULT_READ_CHARS}.` },
      },
    },
  },
};

function integer(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function topLevelKeys(content: string): string[] {
  try {
    const value = JSON.parse(content) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>).slice(0, 30)
      : [];
  } catch {
    return [];
  }
}

export class ToolResultCache {
  private readonly entries = new Map<string, CachedToolResult>();

  prepare(content: string, source: string): PreparedToolResult {
    if (content.length <= MAX_INLINE_CHARS) return { content, cached: false, originalLength: content.length };
    while (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value as string);
    const id = `result_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const cached = content.slice(0, MAX_CACHED_CHARS);
    const entry: CachedToolResult = {
      content: cached,
      originalLength: content.length,
      source,
      truncated: cached.length < content.length,
    };
    this.entries.set(id, entry);
    const keys = topLevelKeys(content);
    const headLength = 4_800;
    const tailLength = 1_600;
    const head = content.slice(0, headLength);
    const tail = content.slice(-tailLength);
    const truncation = entry.truncated
      ? ` The in-memory cache contains the first ${entry.content.length} characters.`
      : "";
    const keySummary = keys.length ? `\nTop-level JSON keys: ${keys.join(", ")}` : "";
    const bounded = `[Large tool result cached]\nHandle: ${id}\nSource: ${source}\nOriginal size: ${content.length} characters.${truncation}${keySummary}\n\nThe full result is intentionally excluded from this model turn to prevent context overload. Use ${INSPECT_TOOL_RESULT_NAME} with a query for a workflow name, node name, node ID, field, or expression. Use offset/limit only when search is insufficient.\n\n--- BEGINNING EXCERPT ---\n${head}\n--- ENDING EXCERPT ---\n${tail}`;
    return { content: bounded.slice(0, MAX_INLINE_CHARS), cached: true, id, originalLength: content.length };
  }

  inspect(args: Record<string, unknown>): string {
    const id = typeof args.id === "string" ? args.id : "";
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown or expired tool-result handle: ${id || "(missing)"}`);
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query) return this.search(entry, id, query);
    const offset = integer(args.offset, 0, 0, Math.max(0, entry.content.length - 1));
    const limit = integer(args.limit, DEFAULT_READ_CHARS, 500, MAX_READ_CHARS);
    const end = Math.min(entry.content.length, offset + limit);
    const next = end < entry.content.length ? ` Continue with offset ${end}.` : " End of cached result.";
    return `[${id} · ${entry.source} · characters ${offset}-${end} of ${entry.originalLength}]${next}\n${entry.content.slice(offset, end)}`;
  }

  private search(entry: CachedToolResult, id: string, query: string): string {
    const haystack = entry.content.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    const ranges: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    while (ranges.length < MAX_SEARCH_MATCHES) {
      const index = haystack.indexOf(needle, cursor);
      if (index < 0) break;
      const start = Math.max(0, index - SEARCH_CONTEXT_CHARS);
      const end = Math.min(entry.content.length, index + query.length + SEARCH_CONTEXT_CHARS);
      const previous = ranges[ranges.length - 1];
      if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
      else ranges.push({ start, end });
      cursor = index + Math.max(1, query.length);
    }
    if (!ranges.length) {
      const cacheNote = entry.truncated ? ` The cache contains only the first ${entry.content.length} of ${entry.originalLength} characters.` : "";
      return `[${id}] No case-insensitive matches for ${JSON.stringify(query)}.${cacheNote}`;
    }
    const matches = ranges.map((range, index) => `--- match ${index + 1} · characters ${range.start}-${range.end} ---\n${entry.content.slice(range.start, range.end)}`);
    return `[${id} · ${entry.source}] ${ranges.length} bounded match region(s) for ${JSON.stringify(query)}.\n${matches.join("\n")}`.slice(0, MAX_READ_CHARS);
  }
}
