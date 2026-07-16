type JsonObject = Record<string, unknown>;

export interface WorkflowAudit {
  passed: boolean;
  workflowId: string;
  summary: string;
  checks: string[];
  failures: string[];
  beforeVersion?: string;
  afterVersion?: string;
}

const AUDITED_MUTATIONS = new Set([
  "create_workflow_from_code",
  "update_workflow",
  "publish_workflow",
  "unpublish_workflow",
  "archive_workflow",
]);

export function isAuditedWorkflowMutation(remoteName: string): boolean {
  return AUDITED_MUTATIONS.has(remoteName);
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function parseObject(value: string): JsonObject | undefined {
  try { return object(JSON.parse(value) as unknown); }
  catch { return undefined; }
}

function workflowFromDetails(value: string): JsonObject | undefined {
  const parsed = parseObject(value);
  return object(parsed?.workflow)
    ?? object(object(parsed?.data)?.workflow)
    ?? object(object(parsed?.result)?.workflow);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function deepEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected)
      && actual.length === expected.length
      && actual.every((item, index) => deepEqual(item, expected[index]));
  }
  const actualObject = object(actual);
  const expectedObject = object(expected);
  if (!actualObject || !expectedObject) return false;
  const keys = Object.keys(expectedObject);
  return keys.length === Object.keys(actualObject).length
    && keys.every((key) => key in actualObject && deepEqual(actualObject[key], expectedObject[key]));
}

function containsExpected(actual: unknown, expected: unknown): boolean {
  const expectedObject = object(expected);
  if (!expectedObject) return deepEqual(actual, expected);
  const actualObject = object(actual);
  return Boolean(actualObject) && Object.entries(expectedObject).every(([key, value]) => key in actualObject! && containsExpected(actualObject![key], value));
}

function nodes(workflow: JsonObject): JsonObject[] {
  return Array.isArray(workflow.nodes) ? workflow.nodes.map(object).filter((node): node is JsonObject => Boolean(node)) : [];
}

function nodeByName(workflow: JsonObject, name: unknown): JsonObject | undefined {
  return nodes(workflow).find((node) => node.name === name);
}

function pointerValue(root: unknown, pointer: unknown): unknown {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return undefined;
  return pointer.slice(1).split("/").reduce<unknown>((current, part) => {
    const record = object(current);
    return record?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }, root);
}

function connectionExists(workflow: JsonObject, operation: JsonObject): boolean {
  const source = stringValue(operation.source);
  const target = stringValue(operation.target);
  const type = stringValue(operation.connectionType) || "main";
  const sourceIndex = typeof operation.sourceIndex === "number" ? operation.sourceIndex : 0;
  const targetIndex = typeof operation.targetIndex === "number" ? operation.targetIndex : 0;
  const connections = object(workflow.connections);
  const sourceConnections = object(connections?.[source]);
  const outputs = Array.isArray(sourceConnections?.[type]) ? sourceConnections[type] as unknown[] : [];
  const branch = Array.isArray(outputs[sourceIndex]) ? outputs[sourceIndex] as unknown[] : [];
  return branch.some((candidate) => {
    const connection = object(candidate);
    return connection?.node === target && (connection.type ?? "main") === type && (connection.index ?? 0) === targetIndex;
  });
}

function operationType(operation: JsonObject): string {
  return stringValue(operation.type) || stringValue(operation.operation) || stringValue(operation.op);
}

function verifyOperation(workflow: JsonObject, operation: JsonObject): { passed: boolean; message: string } {
  const type = operationType(operation);
  if (type === "updateNodeParameters") {
    const node = nodeByName(workflow, operation.nodeName);
    const passed = Boolean(node) && (operation.replace === true
      ? deepEqual(node?.parameters, operation.parameters)
      : containsExpected(node?.parameters, operation.parameters));
    return { passed, message: `${type} persisted for node ${JSON.stringify(operation.nodeName)}` };
  }
  if (type === "setNodeParameter") {
    const node = nodeByName(workflow, operation.nodeName);
    const passed = Boolean(node) && deepEqual(pointerValue(node?.parameters, operation.path), operation.value);
    return { passed, message: `${type} persisted at ${String(operation.nodeName)}${String(operation.path)}` };
  }
  if (type === "addNode") {
    const expected = object(operation.node);
    const actual = nodeByName(workflow, expected?.name);
    return { passed: Boolean(actual) && containsExpected(actual, expected), message: `${type} persisted for node ${JSON.stringify(expected?.name)}` };
  }
  if (type === "removeNode") {
    return { passed: !nodeByName(workflow, operation.nodeName), message: `${type} persisted for node ${JSON.stringify(operation.nodeName)}` };
  }
  if (type === "renameNode") {
    const passed = !nodeByName(workflow, operation.oldName) && Boolean(nodeByName(workflow, operation.newName));
    return { passed, message: `${type} persisted from ${JSON.stringify(operation.oldName)} to ${JSON.stringify(operation.newName)}` };
  }
  if (type === "addConnection" || type === "removeConnection") {
    const exists = connectionExists(workflow, operation);
    return { passed: type === "addConnection" ? exists : !exists, message: `${type} persisted from ${JSON.stringify(operation.source)} to ${JSON.stringify(operation.target)}` };
  }
  if (type === "setNodePosition") {
    const node = nodeByName(workflow, operation.nodeName);
    return { passed: Boolean(node) && deepEqual(node?.position, operation.position), message: `${type} persisted for node ${JSON.stringify(operation.nodeName)}` };
  }
  if (type === "setNodeDisabled") {
    const node = nodeByName(workflow, operation.nodeName);
    return { passed: Boolean(node) && node?.disabled === operation.disabled, message: `${type} persisted for node ${JSON.stringify(operation.nodeName)}` };
  }
  if (type === "setNodeSettings") {
    const node = nodeByName(workflow, operation.nodeName);
    return { passed: Boolean(node) && containsExpected(node, operation.settings), message: `${type} persisted for node ${JSON.stringify(operation.nodeName)}` };
  }
  if (type === "setWorkflowMetadata") {
    const expected: JsonObject = {};
    if (typeof operation.name === "string") expected.name = operation.name;
    if (typeof operation.description === "string") expected.description = operation.description;
    return { passed: containsExpected(workflow, expected), message: `${type} persisted` };
  }
  if (type === "setNodeCredential") {
    return { passed: false, message: `${type} cannot be independently observed because get_workflow_details strips credential references` };
  }
  return { passed: false, message: `Unsupported audit operation ${JSON.stringify(type || "(missing type)")}` };
}

export function workflowIdForMutation(remoteName: string, args: JsonObject, mutationResult = ""): string {
  const direct = stringValue(args.workflowId);
  if (direct) return direct;
  if (remoteName === "create_workflow_from_code") {
    const result = parseObject(mutationResult);
    return stringValue(result?.workflowId) || stringValue(object(result?.data)?.workflowId);
  }
  return "";
}

export function auditWorkflowMutation(input: {
  remoteName: string;
  arguments: JsonObject;
  mutationResult: string;
  beforeDetails?: string;
  afterDetails?: string;
}): WorkflowAudit {
  const workflowId = workflowIdForMutation(input.remoteName, input.arguments, input.mutationResult);
  const before = input.beforeDetails ? workflowFromDetails(input.beforeDetails) : undefined;
  const after = input.afterDetails ? workflowFromDetails(input.afterDetails) : undefined;
  const mutation = parseObject(input.mutationResult);
  const checks: string[] = [];
  const failures: string[] = [];
  const pass = (condition: boolean, message: string): void => {
    (condition ? checks : failures).push(message);
  };

  pass(Boolean(workflowId), "Mutation returned or retained a workflow ID");
  pass(Boolean(after), "Fresh get_workflow_details returned the workflow after mutation");
  if (!after) return {
    passed: false,
    workflowId,
    summary: "QA failed: n8n did not return a readable post-mutation workflow snapshot.",
    checks,
    failures,
  };

  pass(stringValue(after.id) === workflowId, "Post-mutation snapshot has the expected workflow ID");
  const beforeVersion = stringValue(before?.versionId);
  const afterVersion = stringValue(after.versionId);
  if (before && input.remoteName !== "create_workflow_from_code") {
    pass(Boolean(afterVersion) && afterVersion !== beforeVersion, "Workflow version changed after mutation");
  }

  if (input.remoteName === "update_workflow") {
    const operations = Array.isArray(input.arguments.operations) ? input.arguments.operations.map(object).filter((item): item is JsonObject => Boolean(item)) : [];
    pass(operations.length > 0, "Update requested at least one operation");
    if (typeof mutation?.appliedOperations === "number") pass(mutation.appliedOperations === operations.length, `n8n reported all ${operations.length} operation(s) applied`);
    else failures.push("Mutation response did not report appliedOperations");
    if (typeof mutation?.error === "string" && mutation.error) failures.push(`Mutation response reported an error: ${mutation.error}`);
    for (const operation of operations) {
      const result = verifyOperation(after, operation);
      pass(result.passed, result.message);
    }
  } else if (input.remoteName === "create_workflow_from_code") {
    pass(Boolean(afterVersion), "Created workflow has a saved version ID");
    if (typeof mutation?.nodeCount === "number") pass(nodes(after).length === mutation.nodeCount, "Created workflow node count matches the mutation response");
  } else if (input.remoteName === "publish_workflow") {
    pass(after.active === true && Boolean(after.activeVersionId), "Workflow is published with an active version");
  } else if (input.remoteName === "unpublish_workflow") {
    pass(after.active === false && !after.activeVersionId, "Workflow is unpublished with no active version");
  } else if (input.remoteName === "archive_workflow") {
    pass(after.isArchived === true, "Workflow is archived");
  }

  const passed = failures.length === 0;
  return {
    passed,
    workflowId,
    summary: passed
      ? `QA passed: ${checks.length} independent post-mutation checks matched the saved n8n workflow.`
      : `QA failed: ${failures.length} post-mutation check(s) did not match the saved n8n workflow.`,
    checks,
    failures,
    beforeVersion: beforeVersion || undefined,
    afterVersion: afterVersion || undefined,
  };
}
