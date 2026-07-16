import assert from "node:assert/strict";
import test from "node:test";
import { auditWorkflowMutation } from "../src/workflow-auditor.js";

function details(workflow: Record<string, unknown>): string {
  return JSON.stringify({ workflow });
}

test("workflow auditor verifies targeted update operations against a fresh saved snapshot", () => {
  const operations = [
    { type: "updateNodeParameters", nodeName: "Transform", parameters: { mode: "qa" } },
    { type: "setNodeParameter", nodeName: "Transform", path: "/options/limit", value: 42 },
    { type: "addNode", node: { name: "New Node", type: "n8n-nodes-base.set", typeVersion: 3 } },
    { type: "removeNode", nodeName: "Removed Node" },
    { type: "renameNode", oldName: "Old Name", newName: "Renamed Node" },
    { type: "addConnection", source: "Transform", target: "New Node" },
    { type: "removeConnection", source: "Transform", target: "Removed Node" },
    { type: "setNodePosition", nodeName: "Transform", position: [100, 200] },
    { type: "setNodeDisabled", nodeName: "Transform", disabled: true },
    { type: "setNodeSettings", nodeName: "Transform", settings: { retryOnFail: true, maxTries: 3 } },
    { type: "setWorkflowMetadata", name: "Audited workflow", description: "Verified" },
  ];
  const before = {
    id: "wf-1",
    versionId: "version-1",
    name: "Old workflow",
    nodes: [
      { name: "Transform", parameters: { mode: "old", options: {} }, position: [0, 0] },
      { name: "Old Name", parameters: {} },
      { name: "Removed Node", parameters: {} },
    ],
    connections: {},
  };
  const after = {
    id: "wf-1",
    versionId: "version-2",
    name: "Audited workflow",
    description: "Verified",
    nodes: [
      { name: "Transform", parameters: { mode: "qa", options: { limit: 42 } }, position: [100, 200], disabled: true, retryOnFail: true, maxTries: 3 },
      { name: "Renamed Node", parameters: {} },
      { name: "New Node", type: "n8n-nodes-base.set", typeVersion: 3, parameters: {} },
    ],
    connections: {
      Transform: { main: [[{ node: "New Node", type: "main", index: 0 }]] },
    },
  };

  const audit = auditWorkflowMutation({
    remoteName: "update_workflow",
    arguments: { workflowId: "wf-1", operations },
    mutationResult: JSON.stringify({ workflowId: "wf-1", appliedOperations: operations.length }),
    beforeDetails: details(before),
    afterDetails: details(after),
  });

  assert.equal(audit.passed, true);
  assert.equal(audit.failures.length, 0);
  assert.equal(audit.beforeVersion, "version-1");
  assert.equal(audit.afterVersion, "version-2");
  assert.ok(audit.checks.length >= operations.length + 4);
});

test("workflow auditor rejects a success response when saved n8n state did not change", () => {
  const workflow = {
    id: "wf-1",
    versionId: "version-1",
    nodes: [{ name: "Transform", parameters: { mode: "old" } }],
    connections: {},
  };
  const audit = auditWorkflowMutation({
    remoteName: "update_workflow",
    arguments: { workflowId: "wf-1", operations: [{ type: "setNodeParameter", nodeName: "Transform", path: "/mode", value: "new" }] },
    mutationResult: JSON.stringify({ workflowId: "wf-1", appliedOperations: 1 }),
    beforeDetails: details(workflow),
    afterDetails: details(workflow),
  });

  assert.equal(audit.passed, false);
  assert.ok(audit.failures.some((failure) => /version changed/i.test(failure)));
  assert.ok(audit.failures.some((failure) => /setNodeParameter/i.test(failure)));
});

test("workflow auditor refuses to certify credential changes hidden by MCP sanitization", () => {
  const before = { id: "wf-1", versionId: "version-1", nodes: [{ name: "HTTP", parameters: {} }], connections: {} };
  const after = { ...before, versionId: "version-2" };
  const audit = auditWorkflowMutation({
    remoteName: "update_workflow",
    arguments: { workflowId: "wf-1", operations: [{ type: "setNodeCredential", nodeName: "HTTP", credentialKey: "httpBasicAuth", credentialId: "credential-1" }] },
    mutationResult: JSON.stringify({ workflowId: "wf-1", appliedOperations: 1 }),
    beforeDetails: details(before),
    afterDetails: details(after),
  });

  assert.equal(audit.passed, false);
  assert.ok(audit.failures.some((failure) => /cannot be independently observed/i.test(failure)));
});
