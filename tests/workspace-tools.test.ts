import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { executeLocalTool, validateWorkflowObject } from "../src/workspace-tools.js";

test("workspace tools stay inside the root and support precise edits", async (t) => {
  const workspace = await mkdtemp(resolve(tmpdir(), "n8ninator-workspace-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  await mkdir(resolve(workspace, "workflows"));
  await writeFile(resolve(workspace, "workflows/example.json"), '{\n  "name": "Before"\n}\n');

  const tree = await executeLocalTool("workspace_tree", { depth: 3 }, workspace);
  assert.match(tree, /workflows\/example\.json/);

  const read = await executeLocalTool("read_file", { path: "workflows/example.json" }, workspace);
  assert.match(read, /2 \|   "name": "Before"/);

  await executeLocalTool("replace_in_file", {
    path: "workflows/example.json",
    old_text: '"Before"',
    new_text: '"After"',
  }, workspace);
  assert.match(await readFile(resolve(workspace, "workflows/example.json"), "utf8"), /After/);

  await executeLocalTool("write_file", { path: "notes/check.md", content: "n8n workflow check\n" }, workspace);
  assert.equal(await readFile(resolve(workspace, "notes/check.md"), "utf8"), "n8n workflow check\n");

  await assert.rejects(() => executeLocalTool("read_file", { path: "../../etc/passwd" }, workspace), /escapes the workspace/);
  await writeFile(resolve(workspace, ".env"), "SECRET=do-not-read\n");
  await assert.rejects(() => executeLocalTool("read_file", { path: ".env" }, workspace), /secret file/);
});

test("search and n8n workflow validation produce useful evidence", async (t) => {
  const workspace = await mkdtemp(resolve(tmpdir(), "n8ninator-search-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  await writeFile(resolve(workspace, "one.json"), '{"node":"Webhook Trigger"}\n');
  await writeFile(resolve(workspace, "two.md"), "No trigger here\n");
  const matches = await executeLocalTool("search_files", { query: "Webhook", file_pattern: "*.json" }, workspace);
  assert.match(matches, /one\.json:1/);
  assert.doesNotMatch(matches, /two\.md/);

  const result = validateWorkflowObject({
    name: "Valid structure",
    nodes: [
      { name: "Webhook", type: "n8n-nodes-base.webhook", position: [0, 0] },
      { name: "Set", type: "n8n-nodes-base.set", position: [200, 0] },
    ],
    connections: { Webhook: { main: [[{ node: "Set", type: "main", index: 0 }]] } },
  });
  assert.equal(result.valid, true);
  assert.equal(result.summary.nodeCount, 2);

  const invalid = validateWorkflowObject({
    nodes: [{ name: "Same", type: "x", position: [0, 0] }, { name: "Same", type: "y", position: [1, 1] }],
    connections: { Missing: { main: [[{ node: "Elsewhere" }]] } },
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes("Duplicate node name")));
  assert.ok(invalid.errors.some((error) => error.includes("Connection target")));
});
