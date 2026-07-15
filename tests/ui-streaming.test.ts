import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("streaming patches only the active assistant message", async () => {
  const source = await readFile(resolve("public/app.js"), "utf8");
  const start = source.indexOf("function handleAgentEvent");
  const end = source.indexOf("async function sendPrompt", start);
  const handler = source.slice(start, end);

  assert.ok(start >= 0 && end > start, "streaming event handler should be present");
  assert.match(handler, /queueStreamingRender\(assistant/);
  assert.doesNotMatch(handler, /renderMessages\(/, "token events must not rebuild the full message list");
  assert.match(source, /data-message-content/);
  assert.match(source, /requestAnimationFrame\(\(\) => \{/);
});
