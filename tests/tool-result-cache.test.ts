import assert from "node:assert/strict";
import test from "node:test";
import { ToolResultCache } from "../src/tool-result-cache.js";

test("large tool results are cached and can be searched without reloading the whole payload", () => {
  const cache = new ToolResultCache();
  const content = `${"x".repeat(14_000)}TARGET_NODE_42${"y".repeat(4_000)}`;
  const prepared = cache.prepare(content, "n8n · get_workflow");

  assert.equal(prepared.cached, true);
  assert.ok(prepared.id);
  assert.ok(prepared.content.length <= 8_000);
  assert.match(prepared.content, /inspect_tool_result/);

  const search = cache.inspect({ id: prepared.id, query: "target_node_42" });
  assert.match(search, /TARGET_NODE_42/);
  assert.ok(search.length <= 12_000);

  const range = cache.inspect({ id: prepared.id, offset: 13_900, limit: 700 });
  assert.match(range, /characters 13900-14600/);
  assert.match(range, /TARGET_NODE_42/);
});

test("small tool results remain inline", () => {
  const cache = new ToolResultCache();
  const prepared = cache.prepare('{"ok":true}', "validate_workflow");
  assert.deepEqual(prepared, { content: '{"ok":true}', cached: false, originalLength: 11 });
});
