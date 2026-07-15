import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_READ_BYTES = 240_000;
const MAX_SEARCH_FILES = 4_000;
const MAX_SEARCH_MATCHES = 250;
const MAX_TREE_ENTRIES = 600;
const MAX_COMMAND_OUTPUT = 80_000;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".n8ninator"]);
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".csv", ".env.example", ".graphql", ".html", ".js", ".json", ".jsonc", ".jsx",
  ".md", ".mjs", ".py", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);

export const LOCAL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "workspace_tree",
      description: "List files and directories inside the active workspace. Use this before assuming the project structure.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative directory. Defaults to '.'." },
          depth: { type: "integer", minimum: 1, maximum: 6, description: "Maximum directory depth. Defaults to 3." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file in the workspace with line numbers. Read relevant files before editing them.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          start_line: { type: "integer", minimum: 1, description: "First line to return. Defaults to 1." },
          end_line: { type: "integer", minimum: 1, description: "Last line to return. Defaults to start_line + 399." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verify_file",
      description: "Deterministically verify exact workspace file contents, lines, and final-newline state. Use this after writing when the user specifies exact content or whitespace.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          expected_content: { type: "string", description: "Optional exact UTF-8 content to compare byte-for-byte." },
          expected_lines: { type: "array", items: { type: "string" }, description: "Optional exact lines without line terminators. Prefer this with final_newline when whitespace escaping could be ambiguous." },
          final_newline: { type: "boolean", description: "Optional required final-newline state." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search text files in the workspace for a literal or regular-expression pattern.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Text or regular expression to find." },
          path: { type: "string", description: "Workspace-relative directory. Defaults to '.'." },
          file_pattern: { type: "string", description: "Optional simple glob such as '*.json' or 'workflows/*.json'." },
          regex: { type: "boolean", description: "Interpret query as a regular expression. Defaults to false." },
          case_sensitive: { type: "boolean", description: "Use case-sensitive matching. Defaults to false." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or fully replace a UTF-8 text file in the workspace. Requires approval unless auto mode is enabled.",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          content: { type: "string", description: "Complete new file contents." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file_lines",
      description: "Create or replace a UTF-8 text file from exact lines and an explicit final-newline setting. Prefer this over write_file when line endings or escaped newline characters matter. Requires approval.",
      parameters: {
        type: "object",
        required: ["path", "lines"],
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          lines: { type: "array", items: { type: "string" }, description: "Exact lines without newline characters." },
          final_newline: { type: "boolean", description: "Append a final newline. Defaults to true." },
          line_ending: { type: "string", enum: ["lf", "crlf"], description: "Line-ending style. Defaults to lf." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_in_file",
      description: "Make a precise text replacement in a workspace file. Fails on ambiguous matches unless replace_all is true. Requires approval.",
      parameters: {
        type: "object",
        required: ["path", "old_text", "new_text"],
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          old_text: { type: "string", description: "Exact existing text to replace." },
          new_text: { type: "string", description: "Replacement text." },
          replace_all: { type: "boolean", description: "Replace every exact match. Defaults to false." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a non-interactive shell command inside the workspace for builds, tests, linting, git inspection, or diagnostics. Requires approval.",
      parameters: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string", description: "Command to run with zsh -lc." },
          cwd: { type: "string", description: "Optional workspace-relative working directory." },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 300, description: "Timeout. Defaults to 120 seconds." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch current public documentation or other internet content over HTTP(S). Returns readable, size-limited text.",
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "An http:// or https:// URL." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "validate_n8n_workflow",
      description: "Run local structural checks on n8n workflow JSON. When n8n MCP is connected, also use its validate_workflow tool for authoritative node validation.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative JSON file." },
          workflow_json: { type: "string", description: "Workflow JSON string. Use either path or workflow_json." },
        },
      },
    },
  },
];

export function localToolNeedsApproval(name: string): boolean {
  return name === "write_file" || name === "write_file_lines" || name === "replace_in_file" || name === "run_command";
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

async function canonicalRoot(workspace: string): Promise<string> {
  return await realpath(resolve(workspace));
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

function assertLexicallyInside(root: string, requested: string): string {
  const target = resolve(root, requested || ".");
  if (!inside(root, target)) throw new Error(`Path escapes the workspace: ${requested}`);
  return target;
}

async function existingWorkspacePath(workspace: string, requested: string): Promise<{ root: string; target: string }> {
  const root = await canonicalRoot(workspace);
  const lexical = assertLexicallyInside(root, requested);
  const target = await realpath(lexical);
  if (!inside(root, target)) throw new Error(`Symlink escapes the workspace: ${requested}`);
  return { root, target };
}

async function writableWorkspacePath(workspace: string, requested: string): Promise<{ root: string; target: string }> {
  const root = await canonicalRoot(workspace);
  const target = assertLexicallyInside(root, requested);
  let ancestor = dirname(target);
  while (ancestor !== root) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      if (!inside(root, canonicalAncestor)) throw new Error(`Parent symlink escapes the workspace: ${requested}`);
      break;
    } catch (error) {
      if (error instanceof Error && error.message.includes("escapes")) throw error;
      ancestor = dirname(ancestor);
    }
  }
  return { root, target };
}

function sensitivePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (name === ".env" || (name.startsWith(".env.") && !name.endsWith(".example"))) return true;
  if (name === "id_rsa" || name === "id_ed25519" || name.endsWith(".pem") || name.endsWith(".key")) return true;
  return false;
}

function assertReadableFile(path: string): void {
  if (sensitivePath(path)) throw new Error("Refusing to expose a likely secret file. Use an .env.example or describe the needed variable names instead.");
}

function likelyTextFile(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.endsWith(".env.example")) return true;
  return TEXT_EXTENSIONS.has(extname(lower)) || !extname(lower);
}

async function workspaceTree(workspace: string, args: Record<string, unknown>): Promise<string> {
  const requested = asString(args.path, ".");
  const depth = asInteger(args.depth, 3, 1, 6);
  const { root, target } = await existingWorkspacePath(workspace, requested);
  if (!(await stat(target)).isDirectory()) throw new Error(`${requested} is not a directory`);
  const lines: string[] = [];
  let entries = 0;

  async function walk(directory: string, level: number): Promise<void> {
    if (entries >= MAX_TREE_ENTRIES || level > depth) return;
    const children = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !IGNORED_DIRECTORIES.has(entry.name) && !sensitivePath(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const child of children) {
      if (entries++ >= MAX_TREE_ENTRIES) break;
      const childPath = resolve(directory, child.name);
      const rel = relative(root, childPath) || ".";
      lines.push(`${"  ".repeat(level)}${child.isDirectory() ? "▾" : "•"} ${rel}${child.isDirectory() ? "/" : ""}`);
      if (child.isDirectory() && !child.isSymbolicLink()) await walk(childPath, level + 1);
    }
  }

  lines.push(`${relative(root, target) || "."}/`);
  await walk(target, 1);
  if (entries >= MAX_TREE_ENTRIES) lines.push(`… truncated after ${MAX_TREE_ENTRIES} entries`);
  return lines.join("\n");
}

async function readWorkspaceFile(workspace: string, args: Record<string, unknown>): Promise<string> {
  const requested = asString(args.path);
  if (!requested) throw new Error("path is required");
  const { target } = await existingWorkspacePath(workspace, requested);
  assertReadableFile(target);
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`${requested} is not a file`);
  if (info.size > MAX_READ_BYTES) throw new Error(`File is ${info.size} bytes; the read limit is ${MAX_READ_BYTES} bytes. Read a smaller generated extract instead.`);
  const content = await readFile(target, "utf8");
  if (content.includes("\0")) throw new Error("File appears to be binary");
  const lines = content.split(/\r?\n/);
  const start = asInteger(args.start_line, 1, 1, Math.max(1, lines.length));
  const end = asInteger(args.end_line, Math.min(lines.length, start + 399), start, Math.min(lines.length, start + 999));
  return lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(5)} | ${line}`).join("\n");
}

async function verifyWorkspaceFile(workspace: string, args: Record<string, unknown>): Promise<string> {
  const requested = asString(args.path);
  if (!requested) throw new Error("path is required");
  const hasExpectedContent = typeof args.expected_content === "string";
  const hasExpectedLines = Array.isArray(args.expected_lines);
  const hasFinalNewline = typeof args.final_newline === "boolean";
  if (!hasExpectedContent && !hasExpectedLines && !hasFinalNewline) {
    throw new Error("Provide expected_content, expected_lines, or final_newline to verify");
  }
  const { root, target } = await existingWorkspacePath(workspace, requested);
  assertReadableFile(target);
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`${requested} is not a file`);
  if (info.size > MAX_READ_BYTES) throw new Error(`File is ${info.size} bytes; the verification limit is ${MAX_READ_BYTES} bytes.`);
  const content = await readFile(target, "utf8");
  if (content.includes("\0")) throw new Error("File appears to be binary");

  const normalized = content.replace(/\r\n/g, "\n");
  const endsWithNewline = /(?:\r\n|\n)$/.test(content);
  const actualLines = content === "" ? [] : normalized.split("\n").slice(0, endsWithNewline ? -1 : undefined);
  const expectedLines = hasExpectedLines
    ? (args.expected_lines as unknown[]).map((line) => {
      if (typeof line !== "string" || /[\r\n]/.test(line)) throw new Error("expected_lines entries must be strings without newline characters");
      return line;
    })
    : undefined;
  const contentMatch = hasExpectedContent ? content === args.expected_content : undefined;
  const linesMatch = expectedLines ? expectedLines.length === actualLines.length && expectedLines.every((line, index) => line === actualLines[index]) : undefined;
  const finalNewlineMatch = hasFinalNewline ? endsWithNewline === args.final_newline : undefined;
  const suppliedChecks = [contentMatch, linesMatch, finalNewlineMatch].filter((value): value is boolean => typeof value === "boolean");
  const exactMatch = suppliedChecks.every(Boolean);
  const lineEnding = content.includes("\r\n")
    ? content.replace(/\r\n/g, "").includes("\n") ? "mixed" : "crlf"
    : content.includes("\n") ? "lf" : "none";
  return JSON.stringify({
    ok: exactMatch,
    path: relative(root, target),
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    lineCount: actualLines.length,
    endsWithNewline,
    lineEnding,
    exactMatch,
    checks: {
      ...(contentMatch === undefined ? {} : { contentMatch }),
      ...(linesMatch === undefined ? {} : { linesMatch }),
      ...(finalNewlineMatch === undefined ? {} : { finalNewlineMatch }),
    },
    actualPreview: JSON.stringify(content.slice(0, 500)),
  });
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

async function collectFiles(directory: string, root: string, output: string[]): Promise<void> {
  if (output.length >= MAX_SEARCH_FILES) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (output.length >= MAX_SEARCH_FILES) return;
    if (IGNORED_DIRECTORIES.has(entry.name) || sensitivePath(entry.name)) continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await collectFiles(fullPath, root, output);
    else if (entry.isFile() && likelyTextFile(fullPath)) output.push(fullPath);
  }
}

async function searchFiles(workspace: string, args: Record<string, unknown>): Promise<string> {
  const query = asString(args.query);
  if (!query) throw new Error("query is required");
  const requested = asString(args.path, ".");
  const { root, target } = await existingWorkspacePath(workspace, requested);
  const pattern = asString(args.file_pattern);
  const patternRegex = pattern ? globToRegExp(pattern) : undefined;
  const flags = args.case_sensitive === true ? "g" : "gi";
  let matcher: RegExp;
  try {
    matcher = args.regex === true ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  } catch (error) {
    throw new Error(`Invalid search expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files: string[] = [];
  const info = await stat(target);
  if (info.isFile()) files.push(target);
  else await collectFiles(target, root, files);
  const matches: string[] = [];
  for (const file of files) {
    if (matches.length >= MAX_SEARCH_MATCHES) break;
    const rel = relative(root, file);
    if (patternRegex && !patternRegex.test(rel)) continue;
    const info = await stat(file);
    if (info.size > MAX_READ_BYTES) continue;
    const content = await readFile(file, "utf8");
    if (content.includes("\0")) continue;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      matcher.lastIndex = 0;
      if (matcher.test(line)) matches.push(`${rel}:${index + 1}: ${line.slice(0, 500)}`);
      if (matches.length >= MAX_SEARCH_MATCHES) break;
    }
  }
  if (!matches.length) return `No matches in ${files.length} searched files.`;
  if (matches.length >= MAX_SEARCH_MATCHES) matches.push(`… truncated after ${MAX_SEARCH_MATCHES} matches`);
  return matches.join("\n");
}

async function writeWorkspaceFile(workspace: string, args: Record<string, unknown>): Promise<string> {
  const requested = asString(args.path);
  if (!requested) throw new Error("path is required");
  const content = asString(args.content);
  const { root, target } = await writableWorkspacePath(workspace, requested);
  if (sensitivePath(target)) throw new Error("Refusing to write a likely secret file. Keep secrets outside the model-accessible workspace.");
  await mkdir(dirname(target), { recursive: true });
  const canonicalParent = await realpath(dirname(target));
  if (!inside(root, canonicalParent)) throw new Error(`Parent symlink escapes the workspace: ${requested}`);
  const temporary = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
  return JSON.stringify({ ok: true, path: relative(root, target), bytes: Buffer.byteLength(content) });
}

async function writeWorkspaceFileLines(workspace: string, args: Record<string, unknown>): Promise<string> {
  const requested = asString(args.path);
  if (!requested) throw new Error("path is required");
  if (!Array.isArray(args.lines)) throw new Error("lines must be an array of strings");
  const lines = (args.lines as unknown[]).map((line) => {
    if (typeof line !== "string" || /[\r\n]/.test(line)) throw new Error("lines entries must be strings without newline characters");
    return line;
  });
  const finalNewline = args.final_newline !== false;
  const lineEnding = args.line_ending === "crlf" ? "\r\n" : "\n";
  const content = `${lines.join(lineEnding)}${finalNewline ? lineEnding : ""}`;
  const result = JSON.parse(await writeWorkspaceFile(workspace, { path: requested, content })) as Record<string, unknown>;
  return JSON.stringify({ ...result, lineCount: lines.length, finalNewline, lineEnding: args.line_ending === "crlf" ? "crlf" : "lf" });
}

async function replaceInWorkspaceFile(workspace: string, args: Record<string, unknown>): Promise<string> {
  const requested = asString(args.path);
  const oldText = asString(args.old_text);
  const newText = asString(args.new_text);
  if (!requested || !oldText) throw new Error("path and non-empty old_text are required");
  const { root, target } = await existingWorkspacePath(workspace, requested);
  assertReadableFile(target);
  const content = await readFile(target, "utf8");
  const count = content.split(oldText).length - 1;
  if (count === 0) throw new Error("old_text was not found; read the file again before retrying");
  if (count > 1 && args.replace_all !== true) throw new Error(`old_text occurs ${count} times; provide more context or set replace_all=true`);
  const updated = args.replace_all === true ? content.split(oldText).join(newText) : content.replace(oldText, newText);
  const temporary = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  await writeFile(temporary, updated, "utf8");
  await rename(temporary, target);
  return JSON.stringify({ ok: true, path: relative(root, target), replacements: args.replace_all === true ? count : 1 });
}

async function runCommand(workspace: string, args: Record<string, unknown>): Promise<string> {
  const command = asString(args.command).trim();
  if (!command) throw new Error("command is required");
  const cwdRequest = asString(args.cwd, ".");
  const { target: cwd } = await existingWorkspacePath(workspace, cwdRequest);
  if (!(await stat(cwd)).isDirectory()) throw new Error("cwd must be a directory");
  const timeout = asInteger(args.timeout_seconds, 120, 1, 300) * 1000;
  try {
    const { stdout, stderr } = await execFileAsync("/bin/zsh", ["-lc", command], {
      cwd,
      timeout,
      maxBuffer: MAX_COMMAND_OUTPUT,
      env: { ...process.env, CI: process.env.CI ?? "1", NO_COLOR: "1" },
    });
    return JSON.stringify({ ok: true, exitCode: 0, stdout: stdout.slice(0, MAX_COMMAND_OUTPUT), stderr: stderr.slice(0, MAX_COMMAND_OUTPUT) });
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    return JSON.stringify({
      ok: false,
      exitCode: failure.code ?? null,
      killed: Boolean(failure.killed),
      error: failure.message,
      stdout: (failure.stdout ?? "").slice(0, MAX_COMMAND_OUTPUT),
      stderr: (failure.stderr ?? "").slice(0, MAX_COMMAND_OUTPUT),
    });
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function fetchUrl(args: Record<string, unknown>): Promise<string> {
  const raw = asString(args.url);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("url must be a valid HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) URLs are supported");
  const response = await fetch(url, {
    headers: { "User-Agent": "n8ninator/0.2 (+https://github.com/MattLocke/n8ninator)" },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  const rawText = (await response.text()).slice(0, 600_000);
  const type = response.headers.get("content-type") ?? "";
  const text = type.includes("text/html") ? htmlToText(rawText) : rawText;
  return JSON.stringify({ url: response.url, status: response.status, contentType: type, truncated: rawText.length >= 600_000, content: text.slice(0, 450_000) });
}

export function validateWorkflowObject(value: unknown): { valid: boolean; errors: string[]; warnings: string[]; summary: Record<string, unknown> } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, errors: ["Workflow must be a JSON object."], warnings, summary: {} };
  }
  const workflow = value as Record<string, unknown>;
  if (typeof workflow.name !== "string" || !workflow.name.trim()) warnings.push("Workflow has no non-empty name.");
  if (!Array.isArray(workflow.nodes)) errors.push("nodes must be an array.");
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const names = new Set<string>();
  const types = new Set<string>();
  for (const [index, rawNode] of nodes.entries()) {
    if (typeof rawNode !== "object" || rawNode === null || Array.isArray(rawNode)) {
      errors.push(`nodes[${index}] must be an object.`);
      continue;
    }
    const node = rawNode as Record<string, unknown>;
    const name = typeof node.name === "string" ? node.name : "";
    const type = typeof node.type === "string" ? node.type : "";
    if (!name) errors.push(`nodes[${index}] has no name.`);
    else if (names.has(name)) errors.push(`Duplicate node name: ${name}`);
    else names.add(name);
    if (!type) errors.push(`nodes[${index}] (${name || "unnamed"}) has no type.`);
    else types.add(type);
    if (!Array.isArray(node.position) || node.position.length !== 2 || node.position.some((coordinate) => typeof coordinate !== "number")) {
      warnings.push(`Node ${name || index} has no valid [x, y] position.`);
    }
    if (node.credentials && typeof node.credentials === "object") warnings.push(`Node ${name || index} contains credential references; confirm no secret values are embedded before committing.`);
  }
  if (typeof workflow.connections !== "object" || workflow.connections === null || Array.isArray(workflow.connections)) {
    errors.push("connections must be an object.");
  } else {
    for (const [source, rawOutputs] of Object.entries(workflow.connections as Record<string, unknown>)) {
      if (!names.has(source)) errors.push(`Connection source does not match a node: ${source}`);
      const serialized = JSON.stringify(rawOutputs);
      for (const match of serialized.matchAll(/"node"\s*:\s*"([^"]+)"/g)) {
        const target = match[1];
        if (target && !names.has(target)) errors.push(`Connection target does not match a node: ${target}`);
      }
    }
  }
  if (nodes.length === 0) warnings.push("Workflow has no nodes.");
  const triggerTypes = [...types].filter((type) => /trigger|webhook/i.test(type));
  if (!triggerTypes.length && nodes.length) warnings.push("No obvious trigger node was found.");
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    summary: { name: workflow.name ?? null, nodeCount: nodes.length, connectionSources: workflow.connections && typeof workflow.connections === "object" ? Object.keys(workflow.connections).length : 0, nodeTypes: [...types].sort() },
  };
}

async function validateN8nWorkflow(workspace: string, args: Record<string, unknown>): Promise<string> {
  const requested = asString(args.path);
  const inline = asString(args.workflow_json);
  if (!requested && !inline) throw new Error("Provide path or workflow_json");
  let parsed: unknown;
  try {
    if (inline) parsed = JSON.parse(inline);
    else {
      const { target } = await existingWorkspacePath(workspace, requested);
      assertReadableFile(target);
      parsed = JSON.parse(await readFile(target, "utf8"));
    }
  } catch (error) {
    return JSON.stringify({ valid: false, errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`], warnings: [], summary: {} });
  }
  return JSON.stringify(validateWorkflowObject(parsed));
}

export async function executeLocalTool(name: string, args: Record<string, unknown>, workspace: string): Promise<string> {
  switch (name) {
    case "workspace_tree": return await workspaceTree(workspace, args);
    case "read_file": return await readWorkspaceFile(workspace, args);
    case "verify_file": return await verifyWorkspaceFile(workspace, args);
    case "search_files": return await searchFiles(workspace, args);
    case "write_file": return await writeWorkspaceFile(workspace, args);
    case "write_file_lines": return await writeWorkspaceFileLines(workspace, args);
    case "replace_in_file": return await replaceInWorkspaceFile(workspace, args);
    case "run_command": return await runCommand(workspace, args);
    case "fetch_url": return await fetchUrl(args);
    case "validate_n8n_workflow": return await validateN8nWorkflow(workspace, args);
    default: throw new Error(`Unknown local tool: ${name}`);
  }
}

export function compactToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (/token|authorization|password|secret/i.test(key)) compact[key] = "[redacted]";
    else if (typeof value === "string" && value.length > 800) compact[key] = `${value.slice(0, 800)}… (${value.length} chars)`;
    else compact[key] = value;
  }
  return compact;
}
