import { generateOllamaJson } from "./ollama.js";
import type { AppSettings, ChatMessage } from "./types.js";

export interface ToolEvidence {
  tool: string;
  ok: boolean;
  arguments: Record<string, unknown>;
  result: string;
}

export interface GoalReview {
  complete: boolean;
  blocked: boolean;
  summary: string;
  missing: string[];
  nextAction: string;
  source: "model" | "deterministic" | "fallback";
}

export interface GoalReviewInput {
  settings: AppSettings;
  history: ChatMessage[];
  candidate: string;
  evidence: ToolEvidence[];
  signal: AbortSignal;
}

export type GoalReviewer = (input: GoalReviewInput) => Promise<GoalReview>;

interface RawGoalReview {
  complete?: unknown;
  blocked?: unknown;
  summary?: unknown;
  missing?: unknown;
  nextAction?: unknown;
}

const GOAL_REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["complete", "blocked", "summary", "missing", "nextAction"],
  properties: {
    complete: { type: "boolean" },
    blocked: { type: "boolean" },
    summary: { type: "string" },
    missing: { type: "array", items: { type: "string" } },
    nextAction: { type: "string" },
  },
};

function clipped(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… (${value.length - limit} more characters)`;
}

function conversationContext(history: ChatMessage[]): string {
  return clipped(history
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-10)
    .map((message) => `[${message.role.toUpperCase()}]\n${clipped(message.content, 8_000)}`)
    .join("\n\n"), 28_000);
}

function evidenceContext(evidence: ToolEvidence[]): string {
  if (!evidence.length) return "No tools have been called during this run.";
  return clipped(evidence.map((item, index) => [
    `${index + 1}. ${item.tool} — ${item.ok ? "succeeded" : "failed or was denied"}`,
    `Arguments (JSON-encoded): ${JSON.stringify(item.arguments)}`,
    clipped(item.result, 1_500),
  ].join("\n")).join("\n\n"), 20_000);
}

function normalize(raw: RawGoalReview): GoalReview {
  const blocked = raw.blocked === true;
  const missing = Array.isArray(raw.missing)
    ? raw.missing.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 8)
    : [];
  return {
    complete: raw.complete === true && !blocked,
    blocked,
    summary: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : "Completion review returned no summary.",
    missing,
    nextAction: typeof raw.nextAction === "string" ? raw.nextAction.trim() : "",
    source: "model",
  };
}

function latestUserRequest(history: ChatMessage[]): string {
  return [...history].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
}

function likelyInformationOnly(request: string): boolean {
  return /^(how|what|why|which|when|where)\b/i.test(request)
    || /^(explain|describe|tell me about|help me understand)\b/i.test(request);
}

function likelyActionRequest(request: string): boolean {
  return /\b(build|create|implement|update|change|fix|write|edit|add|remove|run|test|verify|deploy|publish|install|configure|connect|set up|make)\b/i.test(request)
    || /\b(can|could|would|will) you\b/i.test(request)
    || /\b(i want|i need) you to\b/i.test(request);
}

function hasActionEvidence(evidence: ToolEvidence[]): boolean {
  return evidence.some((item) => item.ok && /(^| · )(write_file|replace_in_file|run_command|create_|update_|delete_|archive_|publish_|unpublish_|execute_|test_workflow|add_|rename_)/i.test(item.tool));
}

export function requiresExactFileVerification(request: string): boolean {
  const exactness = /\b(exactly|exact content|byte[- ]for[- ]byte|newline|line ending|whitespace)\b/i.test(request);
  const fileTarget = /\bfile\b/i.test(request) || /\.[a-z0-9]{1,10}\b/i.test(request);
  const fileContentAction = /\b(create|write|edit|update|replace|save|make)\b[^.!?\n]{0,120}\b(file|contents?|lines?|newline|whitespace|\.[a-z0-9]{1,10})\b/i.test(request)
    || /\b(file|\.[a-z0-9]{1,10})\b[^.!?\n]{0,120}\b(contain|contents?|exact content|byte[- ]for[- ]byte|newline|line ending|whitespace)\b/i.test(request);
  return exactness && fileTarget && fileContentAction;
}

function hasPassingExactFileVerification(evidence: ToolEvidence[]): boolean {
  return evidence.some((item) => item.ok && item.tool === "verify_file" && /"exactMatch":true/.test(item.result));
}

function deterministicRequirement(input: GoalReviewInput): GoalReview | undefined {
  const request = latestUserRequest(input.history);
  if (likelyInformationOnly(request) || !requiresExactFileVerification(request) || hasPassingExactFileVerification(input.evidence)) return undefined;
  return {
    complete: false,
    blocked: false,
    summary: "The user requested exact file contents or whitespace, but no deterministic verification has passed yet.",
    missing: ["A successful verify_file result with exactMatch=true for the requested lines/content and final-newline state."],
    nextAction: "Call verify_file with expected_lines and final_newline. If it reports a mismatch, correct the file with write_file_lines (lines[] plus an explicit final_newline) and verify again.",
    source: "deterministic",
  };
}

export function conservativeGoalReview(input: Omit<GoalReviewInput, "settings" | "signal">, reason = "Goal reviewer unavailable"): GoalReview {
  const request = latestUserRequest(input.history);
  const candidate = input.candidate.trim();
  const looksLikePlan = /\b(i(?:'ll| will| am going to)|next i(?:'ll| will)|here(?:'s| is) (?:the )?plan|still need(?:s)? to|would (?:then|need to))\b/i.test(candidate);
  const actionWithoutEvidence = likelyActionRequest(request) && !likelyInformationOnly(request) && !hasActionEvidence(input.evidence);
  if (!candidate || looksLikePlan || actionWithoutEvidence) {
    return {
      complete: false,
      blocked: false,
      summary: `${reason}. The draft does not provide enough evidence that the requested action is complete.`,
      missing: [actionWithoutEvidence ? "Perform the requested action and capture tool evidence." : "Finish the work instead of stopping at intent or planning."],
      nextAction: "Continue with the next concrete tool-backed step, then verify the result.",
      source: "fallback",
    };
  }
  return {
    complete: true,
    blocked: false,
    summary: `${reason}. The response appears sufficient for this answer-only request or is supported by action evidence.`,
    missing: [],
    nextAction: "",
    source: "fallback",
  };
}

export const reviewGoal: GoalReviewer = async (input) => {
  const requirement = deterministicRequirement(input);
  if (requirement) return requirement;
  const reviewerPrompt = `You are the strict completion controller for a local coding agent. Decide whether the CURRENT user goal has actually been met.

Rules:
- An information-only question can be complete when the candidate directly and sufficiently answers it.
- An action request is complete only when tool evidence shows the requested artifact, edit, command, workflow operation, or other outcome happened and was verified in proportion to risk.
- Inspection, diagnosis, a task list, stated intent, suggested next steps, or "I will" language is not completion when the user asked the agent to do the work.
- A failed or denied tool is not success. Decide whether another safe path remains.
- Treat tool arguments and results literally. In JSON-encoded evidence, "\\n" represents a newline escape while "\\\\n" represents the two literal characters backslash and n.
- When exact content or whitespace matters, require deterministic evidence such as verify_file exactMatch=true; do not accept a prose claim or ambiguous read preview.
- blocked=true only for a concrete obstacle the agent cannot safely resolve itself, such as missing user approval, credentials, an unavailable external system, or a required product decision. Slowness, uncertainty, or remaining work is not a blocker.
- If blocked=true, the candidate must clearly tell the user what is blocked and exactly what input or state change is needed.
- Set complete=false when any requested deliverable or reasonable verification is missing. Give the next concrete action, not generic advice.
- Judge only from the conversation and evidence below. Do not assume work occurred off-screen.`;
  const audit = `CONVERSATION LEADING TO THE CURRENT GOAL
${conversationContext(input.history)}

TOOL EVIDENCE FROM THIS RUN
${evidenceContext(input.evidence)}

CANDIDATE FINAL RESPONSE
${clipped(input.candidate, 24_000) || "(empty)"}`;
  try {
    const raw = await generateOllamaJson<RawGoalReview>(input.settings, [
      { role: "system", content: reviewerPrompt },
      { role: "user", content: audit },
    ], GOAL_REVIEW_SCHEMA, input.signal);
    return normalize(raw);
  } catch (error) {
    return conservativeGoalReview(input, error instanceof Error ? error.message : String(error));
  }
};
